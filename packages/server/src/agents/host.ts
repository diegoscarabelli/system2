/**
 * Agent Host
 *
 * Manages the Guide agent session using Pi SDK with JSONL persistence.
 * Includes automatic failover when API errors occur.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from '@mariozechner/pi-coding-agent';
import type { LlmConfig, LlmProvider, ServicesConfig, ToolsConfig } from '@system2/shared';
import matter from 'gray-matter';
import type { DatabaseClient } from '../db/client.js';
import { AuthResolver } from './auth-resolver.js';
import type { AgentRegistry } from './registry.js';
import { calculateDelay, categorizeError, shouldFailover, shouldRetry, sleep } from './retry.js';
import { rotateSessionIfNeeded } from './session-rotation.js';
import { createBashTool } from './tools/bash.js';
import { createMessageAgentTool } from './tools/message-agent.js';
import { createQueryDatabaseTool } from './tools/query-database.js';
import { createReadTool } from './tools/read.js';
import { createShowArtifactTool } from './tools/show-artifact.js';
import { createWebFetchTool } from './tools/web-fetch.js';
import { createWebSearchTool } from './tools/web-search.js';
import { createWriteTool } from './tools/write.js';
import './types.js'; // Import custom message type declarations

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYSTEM2_DIR = join(homedir(), '.system2');
// Agent files are bundled in the package dist at dist/agents/
const AGENT_DIR = join(__dirname, 'agents');
const AGENT_LIBRARY_DIR = join(AGENT_DIR, 'library');

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
  agentId: number;
  registry: AgentRegistry;
  llmConfig: LlmConfig;
  servicesConfig?: ServicesConfig;
  toolsConfig?: ToolsConfig;
}

export class AgentHost {
  private session: AgentSession | null = null;
  private db: DatabaseClient;
  readonly agentId: number;
  private registry: AgentRegistry;
  private servicesConfig?: ServicesConfig;
  private toolsConfig?: ToolsConfig;
  private authResolver: AuthResolver;
  private modelRegistry: ModelRegistry;
  private listeners: Set<(event: AgentSessionEvent) => void> = new Set();
  private currentProvider: LlmProvider;
  private retryAttempts: Map<string, number> = new Map(); // Track retries per error type
  private isReinitializing = false;
  private pendingPrompt: string | null = null;

  constructor(config: AgentHostConfig) {
    this.db = config.db;
    this.agentId = config.agentId;
    this.registry = config.registry;
    this.servicesConfig = config.servicesConfig;
    this.toolsConfig = config.toolsConfig;

    // Initialize AuthResolver with failover support
    this.authResolver = new AuthResolver(config.llmConfig);
    const authStorage = this.authResolver.createAuthStorage();
    this.modelRegistry = new ModelRegistry(authStorage);
    this.currentProvider = this.authResolver.primaryProvider;

    console.log('[AgentHost] Auth status:', this.authResolver.getStatus());
  }

  /**
   * Initialize the agent session (must be called before use)
   */
  async initialize(): Promise<void> {
    // Look up the agent record from the database
    const agentRecord = this.db.getAgent(this.agentId);
    if (!agentRecord) {
      throw new Error(`Agent with ID ${this.agentId} not found in database`);
    }
    console.log('[AgentHost] Agent:', { id: agentRecord.id, role: agentRecord.role });

    // Session directory — use role_id format (e.g., sessions/guide_1/)
    const sessionDirName = `${agentRecord.role}_${agentRecord.id}`;
    const agentSessionDir = join(SYSTEM2_DIR, 'sessions', sessionDirName);

    // Ensure session directory exists
    if (!existsSync(agentSessionDir)) {
      mkdirSync(agentSessionDir, { recursive: true });
    }

    // Rotate session file if it exceeds size threshold (10MB)
    const rotated = rotateSessionIfNeeded(agentSessionDir, SYSTEM2_DIR);
    if (rotated) {
      console.log('[AgentHost] Session file rotated to new file');
    }

    // Load shared agent reference (prepended to all agent system prompts)
    const agentsRefPath = join(AGENT_DIR, 'agents.md');
    const agentsRefContent = readFileSync(agentsRefPath, 'utf-8');

    // Load agent-specific definition (Markdown with YAML frontmatter)
    const definitionPath = join(AGENT_LIBRARY_DIR, `${agentRecord.role}.md`);
    const definitionFile = readFileSync(definitionPath, 'utf-8');
    const { data: agentMeta, content: agentPrompt } = matter(definitionFile);
    const agentConfig = agentMeta as AgentDefinition;
    // Static parts of the system prompt (loaded once)
    const staticPrompt = `${agentsRefContent}\n\n${agentPrompt}`;

    const llmProvider = this.currentProvider;

    console.log('[AgentHost] Agent config loaded:', {
      name: agentConfig.name,
      models: agentConfig.models,
      provider: llmProvider,
    });

    // Get model ID from agent library config
    const modelId = agentConfig.models[llmProvider as keyof typeof agentConfig.models];
    if (!modelId) {
      throw new Error(`No model configured for provider: ${llmProvider}`);
    }

    console.log('[AgentHost] Selected model:', modelId, 'for provider:', llmProvider);

    // Find model using registry
    const model = this.modelRegistry.find(llmProvider, modelId);
    if (!model) {
      throw new Error(`Model not found: ${llmProvider}/${modelId}`);
    }

    console.log('[AgentHost] Model found:', model ? 'YES' : 'NO');

    // Create resource loader with custom system prompt
    const resourceLoader = new DefaultResourceLoader({
      cwd: SYSTEM2_DIR,
      agentDir: SYSTEM2_DIR,
      // Override system prompt: static agent instructions + fresh knowledge files on every call
      systemPromptOverride: () => `${staticPrompt}${this.loadKnowledgeContext()}`,
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
      sessionManager: SessionManager.continueRecent(SYSTEM2_DIR, agentSessionDir),
      authStorage: this.authResolver.createAuthStorage(),
      modelRegistry: this.modelRegistry,
      resourceLoader,
      model,
      customTools: this.buildTools(),
      thinkingLevel: 'high', // Enable extended thinking for transparency
    });

    this.session = session;

    // Subscribe to session events and forward to listeners
    session.subscribe((event) => {
      // Check for API errors that need failover handling
      this.handlePotentialError(event);

      // Forward to external listeners
      this.listeners.forEach((listener) => {
        listener(event);
      });
    });

    console.log(`[AgentHost] ${agentRecord.role} agent session initialized with JSONL persistence`);
    console.log('[AgentHost] Using provider:', this.currentProvider);
  }

  /**
   * Handle potential API errors and trigger failover if needed.
   */
  private async handlePotentialError(event: AgentSessionEvent): Promise<void> {
    // Look for error events in message completions (message_end contains final message data)
    if (event.type !== 'message_end') return;

    const eventWithMessage = event as unknown as {
      message?: { stopReason?: string; errorMessage?: string };
    };
    const message = eventWithMessage.message;
    if (!message || message.stopReason !== 'error' || !message.errorMessage) return;

    // Don't handle errors while already reinitializing
    if (this.isReinitializing) return;

    const errorMessage = message.errorMessage;
    console.log('[AgentHost] API error detected:', errorMessage);

    // Categorize the error
    const category = categorizeError({ message: errorMessage });
    console.log('[AgentHost] Error category:', category);

    // Get retry key for this error type
    const retryKey = `${this.currentProvider}:${category}`;
    const currentAttempts = this.retryAttempts.get(retryKey) ?? 0;

    // Check if we should retry
    if (shouldRetry(category, currentAttempts)) {
      const delay = calculateDelay(currentAttempts);
      console.log(
        `[AgentHost] Retrying in ${Math.round(delay)}ms (attempt ${currentAttempts + 1})`
      );

      this.retryAttempts.set(retryKey, currentAttempts + 1);

      // Wait and retry with the same provider
      await sleep(delay);

      // Retry the pending prompt if there is one
      if (this.pendingPrompt && this.session) {
        console.log('[AgentHost] Retrying prompt...');
        await this.session.prompt(this.pendingPrompt);
      }
      return;
    }

    // Check if we should failover
    const retriesExhausted = !shouldRetry(category, currentAttempts);
    if (shouldFailover(category, retriesExhausted)) {
      // Determine failure reason for cooldown tracking
      const failureReason =
        category === 'auth' ? 'auth' : category === 'rate_limit' ? 'rate_limit' : 'transient';

      // Mark current key as failed
      const hasMore = this.authResolver.markKeyFailed(this.currentProvider, failureReason);

      if (hasMore) {
        // Get next available provider
        const nextProvider = this.authResolver.getNextProvider();
        if (nextProvider) {
          console.log(`[AgentHost] Failing over from ${this.currentProvider} to ${nextProvider}`);
          await this.reinitializeWithProvider(nextProvider);
          return;
        }
      }

      console.log('[AgentHost] No fallback providers available, error will be surfaced to user');
    }

    // Reset retry attempts for next error
    this.retryAttempts.clear();
  }

  /**
   * Reinitialize the agent session with a different provider.
   */
  private async reinitializeWithProvider(provider: LlmProvider): Promise<void> {
    if (this.isReinitializing) {
      console.log('[AgentHost] Already reinitializing, skipping');
      return;
    }

    this.isReinitializing = true;
    console.log(`[AgentHost] Reinitializing with provider: ${provider}`);

    try {
      // Update current provider
      this.currentProvider = provider;

      // Recreate model registry with updated auth
      const authStorage = this.authResolver.createAuthStorage();
      this.modelRegistry = new ModelRegistry(authStorage);

      // Reinitialize the session
      await this.initialize();

      // Clear retry attempts on successful reinit
      this.retryAttempts.clear();

      // Emit a custom event to notify UI of provider change
      const failoverEvent: AgentSessionEvent = {
        type: 'status' as AgentSessionEvent['type'],
        message: `Switched to ${provider} due to API issues`,
      } as AgentSessionEvent;
      this.listeners.forEach((listener) => {
        listener(failoverEvent);
      });

      // Retry the pending prompt with the new provider
      if (this.pendingPrompt && this.session) {
        console.log('[AgentHost] Retrying prompt with new provider...');
        await this.session.prompt(this.pendingPrompt);
      }
    } catch (error) {
      console.error('[AgentHost] Failed to reinitialize:', error);
    } finally {
      this.isReinitializing = false;
    }
  }

  /**
   * Load knowledge files and return as context string for the system prompt.
   * Files with only template scaffolding (<=10 lines) are skipped.
   */
  private loadKnowledgeContext(): string {
    const knowledgeDir = join(SYSTEM2_DIR, 'knowledge');
    const sections: string[] = [];
    for (const file of ['infrastructure.md', 'user.md', 'memory.md']) {
      const filePath = join(knowledgeDir, file);
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, 'utf-8');
        if (content.trim().split('\n').length > 10) {
          sections.push(content);
        }
      }
    }
    if (sections.length === 0) return '';
    return `\n\n## Knowledge Base\n\n${sections.join('\n\n---\n\n')}`;
  }

  /**
   * Build the custom tools array, conditionally including web_search if configured.
   */
  private buildTools() {
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool collection matches SDK's AgentTool<any>[]
    const tools: AgentTool<any>[] = [
      createQueryDatabaseTool(this.db),
      createMessageAgentTool(this.agentId, this.registry, this.db),
      createBashTool(),
      createReadTool(),
      createWriteTool(),
      createShowArtifactTool(),
      createWebFetchTool(),
    ];

    // web_search requires a Brave Search API key
    const braveKey = this.servicesConfig?.brave_search?.key;
    if (braveKey && this.toolsConfig?.web_search?.enabled !== false) {
      tools.push(createWebSearchTool(braveKey, this.toolsConfig?.web_search?.max_results));
      console.log('[AgentHost] web_search tool enabled');
    }

    return tools;
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
   * @param content The message content
   * @param options.isSteering If true, the message is queued as a steering message (inserted ASAP into the agent loop)
   */
  async prompt(content: string, options?: { isSteering?: boolean }): Promise<void> {
    if (!this.session) {
      throw new Error('AgentHost not initialized. Call initialize() first.');
    }
    // Store for potential retry on failover
    this.pendingPrompt = content;

    // Use streamingBehavior to queue steering messages properly
    const promptOptions = options?.isSteering ? { streamingBehavior: 'steer' as const } : undefined;

    await this.session.prompt(content, promptOptions);
    // Clear on successful completion (no error triggered failover)
    this.pendingPrompt = null;
  }

  /**
   * Deliver an inter-agent message into this agent's session.
   * Uses sendCustomMessage with customType 'agent_message'.
   *
   * @param content LLM-visible message content (includes sender prefix)
   * @param details Metadata for programmatic use (not sent to LLM)
   * @param urgent If true, uses 'steer' delivery (interrupts mid-turn). Default: 'followUp' (waits for current turn to finish).
   */
  async deliverMessage(
    content: string,
    details: { sender: number; receiver: number; timestamp: number },
    urgent?: boolean
  ): Promise<void> {
    if (!this.session) {
      throw new Error('AgentHost not initialized. Call initialize() first.');
    }
    await this.session.sendCustomMessage(
      {
        customType: 'agent_message',
        content,
        display: false,
        details,
      },
      {
        deliverAs: urgent ? 'steer' : 'followUp',
        triggerTurn: true,
      }
    );
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

  /**
   * Get current context window usage
   */
  getContextUsage() {
    return this.session?.getContextUsage();
  }
}
