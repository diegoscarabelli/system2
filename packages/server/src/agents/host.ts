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
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from '@mariozechner/pi-coding-agent';
import type { LlmConfig, LlmProvider } from '@system2/shared';
import matter from 'gray-matter';
import type { DatabaseClient } from '../db/client.js';
import { AuthResolver } from './auth-resolver.js';
import { calculateDelay, categorizeError, shouldFailover, shouldRetry, sleep } from './retry.js';
import { rotateSessionIfNeeded } from './session-rotation.js';
import { createBashTool } from './tools/bash.js';
import { createQueryDatabaseTool } from './tools/query-database.js';
import { createReadTool } from './tools/read.js';
import { createShowArtifactTool } from './tools/show-artifact.js';
import { createWriteTool } from './tools/write.js';
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
  llmConfig: LlmConfig;
}

export class AgentHost {
  private session: AgentSession | null = null;
  private db: DatabaseClient;
  private authResolver: AuthResolver;
  private modelRegistry: ModelRegistry;
  private listeners: Set<(event: AgentSessionEvent) => void> = new Set();
  private currentProvider: LlmProvider;
  private retryAttempts: Map<string, number> = new Map(); // Track retries per error type
  private isReinitializing = false;
  private pendingPrompt: string | null = null;

  constructor(config: AgentHostConfig) {
    this.db = config.db;

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

    const llmProvider = this.currentProvider;

    console.log('[AgentHost] Guide config loaded:', {
      name: guideConfig.name,
      models: guideConfig.models,
      provider: llmProvider,
    });

    // Get model ID from agent library config
    const modelId = guideConfig.models[llmProvider as keyof typeof guideConfig.models];
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
      authStorage: this.authResolver.createAuthStorage(),
      modelRegistry: this.modelRegistry,
      resourceLoader,
      model,
      customTools: [
        createQueryDatabaseTool(this.db),
        createBashTool(),
        createReadTool(),
        createWriteTool(),
        createShowArtifactTool(),
        // TODO: Add spawn_conductor tool (Phase 2)
      ],
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

    console.log('[AgentHost] Guide agent session initialized with JSONL persistence');
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
