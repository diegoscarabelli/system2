/**
 * Agent Host
 *
 * Manages the Guide agent session using Pi SDK with JSONL persistence.
 */

import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  type AgentSessionEvent,
} from '@mariozechner/pi-coding-agent';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import type { DatabaseClient } from '../db/client.js';
import { createQueryDatabaseTool } from './tools/query-database.js';
import { createBashTool } from './tools/bash.js';
import { createReadTool } from './tools/read.js';
import { createWriteTool } from './tools/write.js';
import { rotateSessionIfNeeded } from './session-rotation.js';
import './types.js'; // Import custom message type declarations

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYSTEM2_DIR = join(homedir(), '.system2');
// Agent library is bundled in the package dist at dist/agents/library/
const AGENT_LIBRARY_DIR = join(__dirname, 'agents', 'library');

interface AgentDefinition {
  name: string;
  description: string;
  version: string;
  models: {
    anthropic: string;
    openai: string;
    google: string;
  };
}

export interface AgentHostConfig {
  db: DatabaseClient;
  llmProvider: string;
  sessionPath?: string;
}

export class AgentHost {
  private session: AgentSession | null = null;
  private db: DatabaseClient;
  private authStorage: AuthStorage;
  private modelRegistry: ModelRegistry;
  private llmProvider: string;
  private listeners: Set<(event: AgentSessionEvent) => void> = new Set();

  constructor(config: AgentHostConfig) {
    this.db = config.db;
    this.llmProvider = config.llmProvider;

    // Initialize AuthStorage pointing to ~/.system2/
    this.authStorage = AuthStorage.create(join(SYSTEM2_DIR, 'auth.json'));
    this.modelRegistry = new ModelRegistry(this.authStorage);
  }

  /**
   * Initialize the agent session (must be called before use)
   */
  async initialize(): Promise<void> {
    // Get or create the Guide agent in database (singleton)
    const guideAgent = this.db.getOrCreateGuideAgent();
    console.log('[AgentHost] Guide agent:', {
      id: guideAgent.id,
      session_path: guideAgent.session_path,
    });

    // Session directory from database record
    const guideSessionDir = join(SYSTEM2_DIR, guideAgent.session_path);

    // Ensure session directory exists
    if (!existsSync(guideSessionDir)) {
      mkdirSync(guideSessionDir, { recursive: true });
    }

    // Rotate session file if it exceeds size threshold (10MB)
    const rotated = rotateSessionIfNeeded(guideSessionDir, SYSTEM2_DIR);
    if (rotated) {
      console.log('[AgentHost] Session file rotated to new file');
    }

    // Load Guide agent definition from package library (Markdown with YAML frontmatter)
    const guideDefinitionPath = join(AGENT_LIBRARY_DIR, 'guide.md');
    const guideFile = readFileSync(guideDefinitionPath, 'utf-8');
    const { data: guideMeta, content: systemPrompt } = matter(guideFile);
    const guideConfig = guideMeta as AgentDefinition;

    console.log('[AgentHost] Guide config loaded:', {
      name: guideConfig.name,
      models: guideConfig.models,
      provider: this.llmProvider,
    });

    // Get model ID from agent library config
    const modelId = guideConfig.models[this.llmProvider as keyof typeof guideConfig.models];
    if (!modelId) {
      throw new Error(`No model configured for provider: ${this.llmProvider}`);
    }

    console.log('[AgentHost] Selected model:', modelId, 'for provider:', this.llmProvider);

    // Find model using registry
    const model = this.modelRegistry.find(this.llmProvider, modelId);
    if (!model) {
      throw new Error(`Model not found: ${this.llmProvider}/${modelId}`);
    }

    console.log('[AgentHost] Model found:', model ? 'YES' : 'NO');

    // Create resource loader with custom system prompt
    const resourceLoader = new DefaultResourceLoader({
      cwd: SYSTEM2_DIR,
      agentDir: SYSTEM2_DIR,
      // Override system prompt with our Guide agent's prompt
      systemPromptOverride: () => systemPrompt,
      // Disable default resource discovery (we manage our own)
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await resourceLoader.reload();

    // Create session with JSONL persistence - use continueRecent to persist across restarts
    const { session } = await createAgentSession({
      cwd: SYSTEM2_DIR,
      agentDir: SYSTEM2_DIR,
      sessionManager: SessionManager.continueRecent(SYSTEM2_DIR, guideSessionDir),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      resourceLoader,
      model,
      customTools: [
        createQueryDatabaseTool(this.db),
        createBashTool(),
        createReadTool(),
        createWriteTool(),
        // TODO: Add spawn_conductor tool (Phase 2)
      ],
      thinkingLevel: 'high', // Enable extended thinking for transparency
    });

    this.session = session;

    // Subscribe to session events and forward to listeners
    session.subscribe((event) => {
      this.listeners.forEach((listener) => listener(event));
    });

    console.log('[AgentHost] Guide agent session initialized with JSONL persistence');
  }

  /**
   * Subscribe to agent events
   */
  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Send a message to the agent
   */
  async prompt(content: string): Promise<void> {
    if (!this.session) {
      throw new Error('AgentHost not initialized. Call initialize() first.');
    }
    await this.session.prompt(content);
  }

  /**
   * Abort current execution
   */
  abort(): void {
    if (this.session) {
      this.session.abort();
    }
  }

  /**
   * Get current agent state
   */
  get state() {
    if (!this.session) {
      throw new Error('AgentHost not initialized. Call initialize() first.');
    }
    return this.session.agent.state;
  }
}
