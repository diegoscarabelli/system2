/**
 * Agent Host
 *
 * Manages the Guide agent session using Pi SDK with JSONL persistence.
 * Includes automatic failover when API errors occur.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmConfig, LlmProvider, ServicesConfig, ToolsConfig } from '@dscarabelli/shared';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';
import matter from 'gray-matter';
import { MessageHistory } from '../chat/history.js';
import type { DatabaseClient } from '../db/client.js';
import { resolveProjectDir } from '../projects/dir.js';
import { AuthResolver } from './auth-resolver.js';
import type { AgentRegistry } from './registry.js';
import {
  calculateDelay,
  categorizeError,
  type ErrorCategory,
  extractStatusCode,
  shouldFailover,
  shouldRetry,
  sleep,
} from './retry.js';
import {
  findMostRecentSession,
  parseSessionEntries,
  rotateSessionIfNeeded,
} from './session-rotation.js';

/** Human-readable label for error categories shown in chat messages. */
function categoryLabel(category: ErrorCategory): string {
  switch (category) {
    case 'auth':
      return 'auth error';
    case 'rate_limit':
      return 'rate limited';
    case 'transient':
      return 'server error';
    case 'client':
      return 'client error';
    case 'context_overflow':
      return 'context overflow';
    case 'unknown':
      return 'error';
  }
}
import { createBashTool } from './tools/bash.js';
import { createEditTool } from './tools/edit.js';
import { createMessageAgentTool } from './tools/message-agent.js';
import { createReadTool } from './tools/read.js';
import { createReadSystem2DbTool } from './tools/read-system2-db.js';
import { type AgentResurrector, createResurrectAgentTool } from './tools/resurrect-agent.js';
import { createShowArtifactTool } from './tools/show-artifact.js';
import { type AgentSpawner, createSpawnAgentTool } from './tools/spawn-agent.js';
import { createTerminateAgentTool } from './tools/terminate-agent.js';
import { createTriggerProjectStoryTool } from './tools/trigger-project-story.js';
import { createWebFetchTool } from './tools/web-fetch.js';
import { createWebSearchTool } from './tools/web-search.js';
import { createWriteTool } from './tools/write.js';
import { createWriteSystem2DbTool } from './tools/write-system2-db.js';
import './types.js'; // Import custom message type declarations

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYSTEM2_DIR = join(homedir(), '.system2');
// Agent files are bundled in the package dist at dist/agents/
const AGENT_DIR = join(__dirname, 'agents');
const AGENT_LIBRARY_DIR = join(AGENT_DIR, 'library');

/** Roles that can spawn, manage, and resurrect agents. Single source of truth for tool access. */
const ORCHESTRATOR_ROLES = new Set(['guide', 'conductor']);

interface AgentDefinition {
  name: string;
  description: string;
  version: string;
  thinking_level?: 'off' | 'minimal' | 'low' | 'medium' | 'high';
  compaction_depth?: number;
  models: {
    anthropic: string;
    cerebras: string;
    google: string;
    groq: string;
    mistral: string;
    openai: string;
    openrouter: string;
    xai: string;
  };
}

export interface AgentHostConfig {
  db: DatabaseClient;
  agentId: number;
  registry: AgentRegistry;
  llmConfig: LlmConfig;
  servicesConfig?: ServicesConfig;
  toolsConfig?: ToolsConfig;
  spawner?: AgentSpawner;
  resurrector?: AgentResurrector;
  chatMaxMessages?: number;
  /** Shared AuthResolver for cross-agent rate limit awareness. Falls back to creating a local instance. */
  authResolver?: AuthResolver;
}

export class AgentHost {
  private session: AgentSession | null = null;
  private db: DatabaseClient;
  readonly agentId: number;
  private registry: AgentRegistry;
  private servicesConfig?: ServicesConfig;
  private toolsConfig?: ToolsConfig;
  private spawner?: AgentSpawner;
  private resurrector?: AgentResurrector;
  private llmConfig: LlmConfig;
  private authResolver: AuthResolver;
  private modelRegistry: ModelRegistry;
  private listeners: Set<(event: AgentSessionEvent) => void> = new Set();
  private currentProvider: LlmProvider;
  private currentKeyIndex = 0;
  private retryAttempts: Map<string, number> = new Map(); // Track retries per error type
  private isReinitializing = false;
  private pendingPrompt: string | null = null;
  private agentRole: string | null = null;
  private agentProject: number | null = null;
  private agentProjectDirName: string | null = null;
  private _sessionDir: string | null = null;
  private _chatCache: MessageHistory | null = null;
  private chatMaxMessages: number;
  private resourceLoader: DefaultResourceLoader | null = null;
  private busy = false;
  private compactionCount = 0;
  private compactionDepth = 0;
  private isPruning = false;
  private contextWindow = 0;
  private contextOverflowHandled = false;
  private unsubscribeSession: (() => void) | null = null;

  constructor(config: AgentHostConfig) {
    this.db = config.db;
    this.agentId = config.agentId;
    this.registry = config.registry;
    this.servicesConfig = config.servicesConfig;
    this.toolsConfig = config.toolsConfig;
    this.spawner = config.spawner;
    this.resurrector = config.resurrector;
    this.chatMaxMessages = config.chatMaxMessages ?? 1000;

    // Store LLM config for openai-compatible provider registration
    this.llmConfig = config.llmConfig;

    // Use shared AuthResolver if provided, otherwise create a local one
    this.authResolver = config.authResolver ?? new AuthResolver(config.llmConfig);
    const authStorage = this.authResolver.createAuthStorage();
    this.modelRegistry = new ModelRegistry(authStorage);
    this.currentProvider = this.authResolver.primaryProvider;
    this.currentKeyIndex = this.authResolver.getActiveKey(this.currentProvider)?.keyIndex ?? 0;

    console.log('[AgentHost] Auth status:', this.authResolver.getStatus());
  }

  /**
   * Initialize the agent session (must be called before use)
   */
  async initialize(): Promise<void> {
    // Detach from old session immediately, before any async work.
    // Prevents stale events from being processed if createAgentSession() throws.
    if (this.unsubscribeSession) {
      this.unsubscribeSession();
      this.unsubscribeSession = null;
    }

    // Look up the agent record from the database
    const agentRecord = this.db.getAgent(this.agentId);
    if (!agentRecord) {
      throw new Error(`Agent with ID ${this.agentId} not found in database`);
    }
    this.agentProject = agentRecord.project ?? null;
    if (this.agentProject !== null) {
      const projectRecord = this.db.getProject(this.agentProject);
      if (projectRecord) {
        const projectsDir = join(SYSTEM2_DIR, 'projects');
        const projectDir = resolveProjectDir(projectsDir, projectRecord.id, projectRecord.name);
        this.agentProjectDirName = basename(projectDir);
      }
    }
    this.agentRole = agentRecord.role;
    console.log('[AgentHost] Agent:', { id: agentRecord.id, role: agentRecord.role });

    // Session directory — use role_id format (e.g., sessions/guide_1/)
    const sessionDirName = `${agentRecord.role}_${agentRecord.id}`;
    const agentSessionDir = join(SYSTEM2_DIR, 'sessions', sessionDirName);

    // Ensure session directory exists
    if (!existsSync(agentSessionDir)) {
      mkdirSync(agentSessionDir, { recursive: true });
    }

    // Store session dir for rotation checks
    this._sessionDir = agentSessionDir;

    // Initialize per-agent chat cache (ring buffer persisted to JSON).
    // Only create on first init; reinitialization (failover) preserves the
    // existing instance to prevent losing entries pushed between file loads.
    if (!this._chatCache) {
      this._chatCache = new MessageHistory(
        join(agentSessionDir, 'chat-cache.json'),
        this.chatMaxMessages
      );
    }

    // Rotate session file only on cold start. During re-initialization (failover),
    // the outgoing SDK session still holds a reference to the active JSONL file;
    // renaming it would cause the SDK to recreate the file without a header on
    // the next append — exactly the hazard rotation is meant to prevent.
    if (!this.session) {
      const rotated = rotateSessionIfNeeded(agentSessionDir, SYSTEM2_DIR);
      if (rotated) {
        console.log('[AgentHost] Session file rotated to new file');
      }
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

    let llmProvider = this.currentProvider;

    console.log('[AgentHost] Agent config loaded:', {
      name: agentConfig.name,
      models: agentConfig.models,
      provider: llmProvider,
    });

    // Resolve model ID — openai-compatible gets it from config, others from agent YAML
    let modelId: string | undefined;

    if (llmProvider === 'openai-compatible') {
      const providerConfig = this.llmConfig.providers['openai-compatible'];
      if (!providerConfig?.model || !providerConfig?.base_url) {
        throw new Error(
          'openai-compatible provider requires both base_url and model in config.toml'
        );
      }
      modelId = providerConfig.model;

      // Register dynamically since it's not a SDK built-in
      this.modelRegistry.registerProvider('openai-compatible', {
        baseUrl: providerConfig.base_url,
        api: 'openai-completions',
        models: [
          {
            id: modelId,
            name: modelId,
            reasoning: providerConfig.compat_reasoning ?? true,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          },
        ],
      });
    } else {
      // Try active provider first, then fallback providers in order
      const providersToTry = [
        llmProvider,
        ...this.authResolver.providerOrder.filter((p) => p !== llmProvider),
      ];

      let resolvedProvider: LlmProvider | undefined;
      for (const provider of providersToTry) {
        const id = agentConfig.models[provider as keyof typeof agentConfig.models];
        if (id) {
          modelId = id;
          resolvedProvider = provider;
          if (provider !== llmProvider) {
            console.log(
              `[AgentHost] No model for ${llmProvider} in ${agentConfig.name}, falling back to ${provider}`
            );
          }
          break;
        }
      }

      if (!resolvedProvider || !modelId) {
        throw new Error(`No model configured for any provider in agent: ${agentConfig.name}`);
      }

      llmProvider = resolvedProvider;
      this.currentProvider = resolvedProvider;
      this.currentKeyIndex = this.authResolver.getActiveKey(resolvedProvider)?.keyIndex ?? 0;
    }

    console.log('[AgentHost] Selected model:', modelId, 'for provider:', llmProvider);

    // Find model using registry
    const model = this.modelRegistry.find(llmProvider, modelId);
    if (!model) {
      throw new Error(`Model not found: ${llmProvider}/${modelId}`);
    }

    console.log('[AgentHost] Model found:', model ? 'YES' : 'NO');

    // Store context window size for overflow recovery
    this.contextWindow = model.contextWindow;

    // Configure auto-compaction to fire at 50% of context window instead of default ~98%.
    // Earlier compaction reduces the chance of hitting per-model token quotas
    // when multiple agents share the same API key.
    const settingsManager = SettingsManager.inMemory({
      compaction: { reserveTokens: Math.floor(model.contextWindow * 0.5) },
    });

    // Create resource loader with custom system prompt
    this.resourceLoader = new DefaultResourceLoader({
      cwd: SYSTEM2_DIR,
      agentDir: SYSTEM2_DIR,
      // Static agent instructions (from package) + dynamic knowledge files (from ~/.system2/).
      // Knowledge files are re-read on every LLM call via reload() before each prompt.
      systemPromptOverride: () =>
        `${staticPrompt}${this.loadKnowledgeContext()}\n\n---\n\nConversation history follows.`,
      // Disable default resource discovery (we manage our own)
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await this.resourceLoader.reload();

    // Create session with JSONL persistence.
    // Use open() on the most recent .jsonl (by mtime) if one exists — this tolerates
    // files that lack a valid session header, which continueRecent() would reject and
    // silently replace with a new empty session. Fall back to continueRecent() only
    // when no .jsonl file exists at all (first-time setup).
    const latestSession = findMostRecentSession(agentSessionDir);
    const sessionManager = latestSession
      ? SessionManager.open(latestSession, agentSessionDir)
      : SessionManager.continueRecent(SYSTEM2_DIR, agentSessionDir);
    const { session } = await createAgentSession({
      cwd: SYSTEM2_DIR,
      agentDir: SYSTEM2_DIR,
      sessionManager,
      authStorage: this.authResolver.createAuthStorage(),
      modelRegistry: this.modelRegistry,
      resourceLoader: this.resourceLoader,
      model,
      customTools: this.buildTools(),
      thinkingLevel: agentConfig.thinking_level ?? 'high',
      settingsManager,
    });

    this.session = session;

    // Initialize compaction pruning
    this.compactionDepth = agentConfig.compaction_depth ?? 0;
    if (this.compactionDepth > 0) {
      this.compactionCount = this.readCompactionCount();
      console.log(
        `[AgentHost] Compaction pruning enabled: depth=${this.compactionDepth}, count=${this.compactionCount}`
      );
    }

    // Subscribe to session events and forward to listeners
    this.unsubscribeSession = session.subscribe((event) => {
      this.handleSessionEvent(event);
    });

    console.log(`[AgentHost] ${agentRecord.role} agent session initialized with JSONL persistence`);
    console.log('[AgentHost] Using provider:', this.currentProvider);
  }

  /**
   * Handle a session event: error detection, busy/pendingPrompt tracking,
   * compaction, and external listener forwarding.
   *
   * Extracted from the initialize() subscribe callback so tests can invoke it directly.
   */
  private handleSessionEvent(event: AgentSessionEvent): void {
    // Check for API errors that need failover handling (async, errors logged internally)
    void this.handlePotentialError(event).catch((err) => {
      console.error('[AgentHost] handlePotentialError threw unexpectedly:', err);
    });

    // Track busy state from agent activity
    if (event.type === 'message_update' || event.type === 'tool_execution_start') {
      if (!this.busy) {
        this.busy = true;
      }
    } else if (event.type === 'agent_end') {
      if (this.busy) {
        this.busy = false;
      }
      // Clear pendingPrompt here — not in prompt() after session.prompt() returns.
      // When streamingBehavior is 'followUp' or 'steer', session.prompt() queues
      // the message and returns immediately, so clearing it there would be too early.
      // Waiting for agent_end ensures the message stays retryable until the turn runs.
      this.pendingPrompt = null;
    }

    // Track compaction for pruning
    this.handleCompactionTracking(event);

    // Forward to external listeners
    this.listeners.forEach((listener) => {
      listener(event);
    });
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

    // Categorize the error and build human-readable prefix for chat messages
    const category = categorizeError({ message: errorMessage });
    const statusCode = extractStatusCode({ message: errorMessage });
    const label = categoryLabel(category);
    const errorPrefix = statusCode ? `${statusCode} ${label}` : label;
    console.log('[AgentHost] Error category:', category);

    // Get retry key for this error type
    const retryKey = `${this.currentProvider}:${category}`;
    const currentAttempts = this.retryAttempts.get(retryKey) ?? 0;

    // Capture before any await — agent_end may clear it before this async handler resumes
    const promptToRetry = this.pendingPrompt;

    // If another agent already put our key in cooldown, skip retries and reinitialize.
    // Uses the tracked key index so we check our actual key, not whatever index
    // another agent may have rotated to.
    if (this.authResolver.isKeyInCooldown(this.currentProvider, this.currentKeyIndex)) {
      const nextProvider = this.authResolver.getNextProvider();
      if (nextProvider) {
        const reason =
          nextProvider === this.currentProvider
            ? `${errorPrefix} on ${this.currentProvider}, rotating to next key`
            : `${errorPrefix} on ${this.currentProvider} (key already in cooldown), switching to ${nextProvider}`;
        console.log(
          `[AgentHost] Key ${this.currentProvider}:${this.currentKeyIndex} already in cooldown`
        );
        await this.reinitializeWithProvider(nextProvider, promptToRetry, reason);
        return;
      }
    }

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
      if (promptToRetry && this.session) {
        console.log('[AgentHost] Retrying prompt...');
        // Restore only if nothing newer arrived during sleep — a new prompt() call during the
        // delay would have set pendingPrompt to the newer message; don't overwrite it.
        this.pendingPrompt = this.pendingPrompt ?? promptToRetry;
        await this.resourceLoader?.reload();
        await this.session.prompt(promptToRetry, { streamingBehavior: 'followUp' });
      }
      return;
    }

    // Check if we should failover
    const retriesExhausted = !shouldRetry(category, currentAttempts);
    if (shouldFailover(category, retriesExhausted)) {
      // Determine failure reason for cooldown tracking
      const failureReason =
        category === 'auth' ? 'auth' : category === 'rate_limit' ? 'rate_limit' : 'transient';

      // Mark our specific key as failed (pass currentKeyIndex to avoid marking the wrong key
      // when another agent has already rotated the shared activeKeys index)
      const hasMore = this.authResolver.markKeyFailed(
        this.currentProvider,
        failureReason,
        errorMessage,
        this.currentKeyIndex
      );

      if (hasMore) {
        // Get next available provider
        const nextProvider = this.authResolver.getNextProvider();
        if (nextProvider) {
          if (nextProvider === this.currentProvider) {
            const reason = `${errorPrefix} on ${this.currentProvider}, rotating to next key`;
            console.log(`[AgentHost] Rotating to next key for ${this.currentProvider}`);
            await this.reinitializeWithProvider(nextProvider, promptToRetry, reason);
          } else {
            const reason = `${errorPrefix} on ${this.currentProvider}, switching to ${nextProvider}`;
            console.log(`[AgentHost] Failing over from ${this.currentProvider} to ${nextProvider}`);
            await this.reinitializeWithProvider(nextProvider, promptToRetry, reason);
          }
          return;
        }
      }

      this.pushSystemMessage(
        `${errorPrefix} on ${this.currentProvider}, all providers unavailable`
      );
      console.log('[AgentHost] No fallback providers available, error will be surfaced to user');
    }

    // Context overflow: truncate JSONL, compact, restore tail, reinitialize.
    // The guard prevents re-entry during recovery; it re-arms after recovery completes.
    // Uses the context_overflow category from categorizeError() which detects token limit
    // errors before status code classification, avoiding false positives on rate-limit
    // errors whose messages may also contain size/token keywords.
    if (category === 'context_overflow' && !this.contextOverflowHandled) {
      this.contextOverflowHandled = true;
      const recovered = await this.handleContextOverflow();
      if (recovered) {
        // Clear the overflow-causing prompt so a future failover doesn't retry it
        this.pendingPrompt = null;
        return;
      }
      // Recovery was a no-op — reset guard so a future overflow can try again
      this.contextOverflowHandled = false;
    }

    // Last resort: if a different provider is available (e.g., primary came out of cooldown),
    // switch to it. This covers cases like being stuck on a dead fallback provider.
    const nextProvider = this.authResolver.getNextProvider();
    if (nextProvider && nextProvider !== this.currentProvider) {
      const reason = `${errorPrefix} on ${this.currentProvider}, switching to ${nextProvider}`;
      console.log(
        `[AgentHost] Recovery: switching from ${this.currentProvider} to ${nextProvider}`
      );
      await this.reinitializeWithProvider(nextProvider, promptToRetry, reason);
      return;
    }

    // All recovery paths exhausted; ensure busy is cleared
    if (this.busy) {
      this.busy = false;
    }

    // Reset retry attempts for next error
    this.retryAttempts.clear();
  }

  /**
   * Reinitialize the agent session with a different provider.
   * @param reason - Human-readable reason for the switch (shown in chat and UI status)
   */
  private async reinitializeWithProvider(
    provider: LlmProvider,
    promptToRetry?: string | null,
    reason?: string
  ): Promise<void> {
    if (this.isReinitializing) {
      console.log('[AgentHost] Already reinitializing, skipping');
      return;
    }

    this.isReinitializing = true;
    console.log(`[AgentHost] Reinitializing with provider: ${provider}`);

    // Old session is dead; clear busy so the agent doesn't appear stuck
    if (this.busy) {
      this.busy = false;
    }

    try {
      // Update current provider and key index
      this.currentProvider = provider;
      this.currentKeyIndex = this.authResolver.getActiveKey(provider)?.keyIndex ?? 0;

      // Push chat message before init so the user sees the reason even if
      // initialization fails. Only for actual failovers, not compaction recovery.
      if (reason) {
        this.pushSystemMessage(reason);
      }

      // Recreate model registry with updated auth
      const authStorage = this.authResolver.createAuthStorage();
      this.modelRegistry = new ModelRegistry(authStorage);

      // Reinitialize the session
      await this.initialize();

      // Clear retry attempts on successful reinit
      this.retryAttempts.clear();

      // Notify UI of provider change (after init succeeds, so the provider
      // indicator only updates when the switch actually worked)
      if (reason) {
        const failoverEvent: AgentSessionEvent = {
          type: 'status' as AgentSessionEvent['type'],
          provider,
          reason,
        } as AgentSessionEvent;
        this.listeners.forEach((listener) => {
          listener(failoverEvent);
        });
      }

      // Retry the pending prompt with the new provider
      if (promptToRetry && this.session) {
        console.log('[AgentHost] Retrying prompt with new provider...');
        // Restore only if nothing newer arrived during reinitialization.
        this.pendingPrompt = this.pendingPrompt ?? promptToRetry;
        await this.session.prompt(promptToRetry, { streamingBehavior: 'followUp' });
      }
    } catch (error) {
      console.error('[AgentHost] Failed to reinitialize:', error);
      if (reason) {
        const msg = error instanceof Error ? error.message : String(error);
        this.pushSystemMessage(`Failed to switch: ${msg}`);
      }
    } finally {
      this.isReinitializing = false;
    }
  }

  /** Push a system-role message into the chat cache (visible in UI history). */
  private pushSystemMessage(content: string): void {
    if (!this._chatCache) return;
    this._chatCache.push({
      id: `msg-${Date.now()}`,
      role: 'system',
      content,
      timestamp: Date.now(),
    });
  }

  /**
   * Load knowledge files and return as context string for the system prompt.
   * Empty files (0 lines) are skipped.
   */
  private loadKnowledgeContext(): string {
    const knowledgeDir = join(SYSTEM2_DIR, 'knowledge');
    const sections: string[] = [];

    const addSection = (filePath: string, content: string) => {
      if (content.trim().split('\n').length > 0) {
        const label = filePath.replace(homedir(), '~').replace(/\\/g, '/');
        sections.push(`### ${label}\n\n${content.trim()}`);
      }
    };

    for (const file of ['infrastructure.md', 'user.md', 'memory.md']) {
      const filePath = join(knowledgeDir, file);
      if (existsSync(filePath)) {
        addSection(filePath, readFileSync(filePath, 'utf-8'));
      }
    }

    // Role-specific knowledge file (guide.md, conductor.md, narrator.md, reviewer.md)
    const roleKnowledgePath = join(knowledgeDir, `${this.agentRole}.md`);
    if (existsSync(roleKnowledgePath)) {
      addSection(roleKnowledgePath, readFileSync(roleKnowledgePath, 'utf-8'));
    }

    // Role-aware activity context:
    // Project-scoped agents get their project log; system-wide agents get daily summaries
    if (this.agentProject !== null && this.agentProjectDirName) {
      const projectLogPath = join(SYSTEM2_DIR, 'projects', this.agentProjectDirName, 'log.md');
      if (existsSync(projectLogPath)) {
        addSection(projectLogPath, readFileSync(projectLogPath, 'utf-8'));
      }
    } else {
      const summariesDir = join(knowledgeDir, 'daily_summaries');
      if (existsSync(summariesDir)) {
        const summaryFiles = readdirSync(summariesDir)
          .filter((f) => f.endsWith('.md'))
          .sort()
          .reverse()
          .slice(0, 2)
          .reverse(); // chronological order
        for (const file of summaryFiles) {
          const filePath = join(summariesDir, file);
          addSection(filePath, readFileSync(filePath, 'utf-8'));
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
      createReadSystem2DbTool(this.db),
      createWriteSystem2DbTool(this.db, this.agentId),
      createMessageAgentTool(this.agentId, this.registry, this.db),
      createBashTool((content, details) => {
        this.session?.sendCustomMessage(
          { customType: 'bash_background', content, display: false, details },
          { deliverAs: 'followUp', triggerTurn: true }
        );
      }),
      createReadTool(),
      createEditTool(),
      createWriteTool(),
      createWebFetchTool(),
    ];

    // web_search requires a Brave Search API key
    const braveKey = this.servicesConfig?.brave_search?.key;
    if (braveKey && this.toolsConfig?.web_search?.enabled !== false) {
      tools.push(createWebSearchTool(braveKey, this.toolsConfig?.web_search?.max_results));
      console.log('[AgentHost] web_search tool enabled');
    }

    // All agents can show artifacts — any agent can now interact with the user directly
    tools.push(createShowArtifactTool(this.db));

    // Guide and Conductor only: spawn, manage, and resurrect agents
    const canOrchestrate = this.agentRole !== null && ORCHESTRATOR_ROLES.has(this.agentRole);

    if (canOrchestrate && this.spawner) {
      tools.push(createSpawnAgentTool(this.db, this.agentId, this.spawner));
      tools.push(createTerminateAgentTool(this.db, this.agentId, this.registry));
      tools.push(createTriggerProjectStoryTool(this.db, this.agentId, this.registry));
    }

    if (canOrchestrate && this.resurrector) {
      tools.push(createResurrectAgentTool(this.db, this.agentId, this.resurrector));
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

    // Use streamingBehavior to queue messages properly if the session is already streaming.
    // Defaulting non-steering messages to 'followUp' prevents silent drops when a background
    // sendCustomMessage turn is in flight — session.prompt() throws if streamingBehavior is
    // undefined and isStreaming is true. 'followUp' is a no-op when the session is idle.
    const promptOptions = options?.isSteering
      ? { streamingBehavior: 'steer' as const }
      : { streamingBehavior: 'followUp' as const };

    // Reload resource loader to pick up knowledge file changes
    await this.resourceLoader?.reload();
    await this.session.prompt(content, promptOptions);
    // pendingPrompt is cleared by handleSessionEvent() on agent_end.
    // Do NOT clear here: for queued turns (streamingBehavior 'followUp'/'steer'),
    // session.prompt() returns immediately and the turn hasn't run yet.
  }

  /**
   * Deliver an inter-agent message into this agent's session.
   * Uses sendCustomMessage with customType 'agent_message'.
   *
   * Fire-and-forget: does NOT await the triggered turn. When the receiver is
   * idle, sendCustomMessage internally calls agent.prompt() which blocks until
   * the entire turn completes — awaiting that would deadlock the caller if
   * agents message each other during their turns.
   *
   * @param content LLM-visible message content (includes sender prefix)
   * @param details Metadata for programmatic use (not sent to LLM)
   * @param urgent If true, uses 'steer' delivery (interrupts mid-turn). Default: 'followUp' (waits for current turn to finish).
   */
  deliverMessage(
    content: string,
    details: { sender: number; receiver: number; timestamp: number },
    urgent?: boolean
  ): void {
    if (!this.session) {
      throw new Error('AgentHost not initialized. Call initialize() first.');
    }

    // Capture delivered message in chat cache for UI history.
    // Inter-agent messages and summaries store full content (tag + body).
    // Scheduled/triggered tasks store only the tag. Untagged content is truncated.
    if (this._chatCache) {
      const tagMatch = content.match(/^\[([^\]]+)\]/);
      let cacheContent: string;

      if (!tagMatch) {
        cacheContent = content.slice(0, 100);
      } else {
        const tag = tagMatch[1];
        const body = content.slice(tagMatch[0].length).replace(/^\n+/, '');

        if (tag.startsWith('Scheduled task:') || tag.startsWith('Task:')) {
          if (tag === 'Scheduled task: project-log') {
            const firstBlankLine = body.search(/\n\s*\n/);
            const metadata =
              firstBlankLine === -1 ? body.slice(0, 4096) : body.slice(0, firstBlankLine);
            const pidMatch = metadata.match(/^project_id:\s*(\d+)/m);
            const pnameMatch = metadata.match(/^project_name:\s*(.+)/m);
            const pid = pidMatch?.[1];
            const pname = pnameMatch?.[1]?.trim();
            cacheContent = pid && pname ? `${tag} #${pid} (${pname})` : tag;
          } else {
            cacheContent = tag;
          }
        } else {
          cacheContent = body ? `${tag}\n\n${body}` : tag;
        }
      }

      this._chatCache.push({
        id: `msg-${Date.now()}`,
        role: 'system',
        content: cacheContent,
        timestamp: details.timestamp,
      });
    }

    // Reload resource loader to pick up knowledge file changes, then deliver.
    // Reload errors are swallowed so a filesystem hiccup never drops a message.
    const session = this.session;
    const reload = this.resourceLoader
      ? this.resourceLoader
          .reload()
          .catch((err) => console.warn('[AgentHost] reload failed, using cached knowledge:', err))
      : Promise.resolve();

    reload
      .then(() =>
        session.sendCustomMessage(
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
        )
      )
      .catch((err) => console.error('[AgentHost] deliverMessage error:', err));
  }

  /**
   * Abort current execution
   */
  abort(): void {
    if (this.session) {
      this.session.abort();
      // abort() may not trigger agent_end, so clear busy and pendingPrompt explicitly
      if (this.busy) {
        this.busy = false;
      }
      this.pendingPrompt = null;
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

  /** Get the agent's role (available after initialize()). */
  get role(): string | null {
    return this.agentRole;
  }

  getProvider(): string {
    return this.currentProvider;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** Session directory path (available after initialize()). */
  get sessionDir(): string | null {
    return this._sessionDir;
  }

  /** Per-agent chat cache for UI message history. */
  get chatCache(): MessageHistory {
    if (!this._chatCache) {
      throw new Error('AgentHost not initialized. Call initialize() first.');
    }
    return this._chatCache;
  }

  /**
   * Handle compaction tracking for pruning.
   * Increments counter on auto-compaction and triggers pruning when threshold is met.
   */
  private handleCompactionTracking(event: AgentSessionEvent): void {
    if (this.compactionDepth <= 0) return;

    // Track auto-compaction counter
    if (event.type === 'auto_compaction_end') {
      this.compactionCount++;
      this.writeCompactionCount(this.compactionCount);
    }

    // Trigger pruning compaction at 30% context usage when counter reaches depth
    if (
      event.type === 'agent_end' &&
      this.compactionCount >= this.compactionDepth &&
      !this.isPruning
    ) {
      const usage = this.getContextUsage();
      if (usage?.percent != null && usage.percent >= 30) {
        this.isPruning = true;
        this.triggerPruningCompaction()
          .catch((err: unknown) => console.error('[AgentHost] Pruning compaction error:', err))
          .finally(() => {
            this.isPruning = false;
          });
      }
    }
  }

  /**
   * Read the persisted compaction count from the session directory.
   * Returns 0 if the file doesn't exist (first run or deleted).
   */
  private readCompactionCount(): number {
    if (!this._sessionDir) return 0;
    const countFile = join(this._sessionDir, '.compaction-count');
    try {
      return parseInt(readFileSync(countFile, 'utf-8').trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Persist the compaction count to the session directory.
   */
  private writeCompactionCount(count: number): void {
    if (!this._sessionDir) return;
    const countFile = join(this._sessionDir, '.compaction-count');
    writeFileSync(countFile, String(count), 'utf-8');
  }

  /**
   * Trigger a pruning compaction that sheds stale information.
   * Uses the Nth oldest compaction summary as a baseline to instruct the LLM
   * to remove information that already existed in the baseline.
   */
  private async triggerPruningCompaction(): Promise<void> {
    if (!this.session || !this._sessionDir) return;

    const baseline = this.findBaselineSummary();
    if (!baseline) {
      console.log('[AgentHost] No baseline found for pruning, skipping');
      return;
    }

    const customInstructions = [
      'IMPORTANT: Override the previous statement about preserving everything',
      'from the previous compaction summary. Instead, use the BASELINE below',
      'as a temporal cutoff. Any information that already existed in this',
      'baseline is stale and must be dropped. Only retain information that',
      'was added AFTER the baseline, plus new messages from the conversation.',
      '',
      'BASELINE:',
      baseline,
    ].join('\n');

    await this.session.compact(customInstructions);
    this.compactionCount = 0;
    this.writeCompactionCount(0);
    console.log(`[AgentHost] Pruning compaction completed for agent ${this.agentId}`);
  }

  /**
   * Find the baseline compaction summary for pruning.
   * The baseline is the oldest compaction in the current window (compactionCount ago).
   * May need to scan older JSONL files if session rotation moved entries.
   */
  private findBaselineSummary(): string | null {
    if (!this.session || !this._sessionDir) return null;

    // Collect compaction summaries from current session entries (chronological order)
    const entries = this.session.sessionManager.getBranch();
    const currentSummaries: string[] = [];
    for (const entry of entries) {
      if (entry.type === 'compaction') {
        const summary = (entry as unknown as { summary?: string }).summary;
        if (summary) currentSummaries.push(summary);
      }
    }

    // Check if we have enough from current session
    if (currentSummaries.length >= this.compactionCount) {
      return currentSummaries[currentSummaries.length - this.compactionCount] ?? null;
    }

    // Need more compaction entries from older JSONL files
    const needed = this.compactionCount - currentSummaries.length;
    const olderSummaries = this.scanOlderSessionFiles(needed);

    // Combine: older summaries (chronological) + current summaries
    const allSummaries = [...olderSummaries, ...currentSummaries];
    if (allSummaries.length < this.compactionCount) return null;

    return allSummaries[allSummaries.length - this.compactionCount] ?? null;
  }

  /**
   * Scan older (rotated) JSONL session files for compaction summaries.
   * Returns up to `needed` summaries in chronological order.
   */
  private scanOlderSessionFiles(needed: number): string[] {
    const sessionDir = this._sessionDir;
    if (!sessionDir) return [];

    let files: string[];
    try {
      files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return [];
    }

    // Sort by mtime descending (newest first)
    const sorted = files
      .map((f) => {
        const fullPath = join(sessionDir, f);
        const stat = statSync(fullPath);
        return { path: fullPath, mtime: stat.mtime.getTime() };
      })
      .sort((a, b) => b.mtime - a.mtime);

    // Skip the most recent file (current session)
    const olderFiles = sorted.slice(1);

    const summaries: string[] = [];

    // Search from newest to oldest archived files
    for (const file of olderFiles) {
      const entries = parseSessionEntries(file.path);
      for (let i = entries.length - 1; i >= 0; i--) {
        const summary = entries[i].type === 'compaction' ? entries[i].summary : undefined;
        if (summary) {
          summaries.unshift(summary);
          if (summaries.length >= needed) return summaries;
        }
      }
    }

    return summaries;
  }

  /**
   * Emergency recovery for context overflow errors.
   *
   * When the context window is exceeded and no API call can succeed, this method:
   * 1. Splits the active JSONL at the last message entry below 90% of context window
   * 2. Truncates the file to that safe point, reinitializes, and compacts
   * 3. Appends the tail (post-split entries) back and reinitializes again
   *
   * The result is a session with a compact summary of the safe history plus the
   * recent tail, consuming a fraction of the context window.
   */
  private async handleContextOverflow(): Promise<boolean> {
    const sessionDir = this.sessionDir;
    if (!this.session || !sessionDir) {
      console.log('[AgentHost] Context overflow: no session or sessionDir, cannot recover');
      return false;
    }

    console.log('[AgentHost] Starting context overflow recovery...');

    // Hoisted so the catch block can restore the tail if recovery fails mid-way
    let activeFile: string | undefined;
    let tailLines: string[] = [];
    let fileTruncated = false;
    let tailAppended = false; // set after tail is written; prevents double-append on failure

    try {
      // Step 1: Find the active JSONL file (most recently modified)
      const jsonlFiles = readdirSync(sessionDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const fullPath = join(sessionDir, f);
          return { path: fullPath, mtime: statSync(fullPath).mtime.getTime() };
        })
        .sort((a, b) => b.mtime - a.mtime);

      if (jsonlFiles.length === 0) {
        console.log('[AgentHost] Context overflow: no JSONL files found');
        return false;
      }

      activeFile = jsonlFiles[0].path;
      const lines = readFileSync(activeFile, 'utf-8')
        .split('\n')
        .filter((l) => l.trim());

      // Step 2: Find last message entry below 90% of context window
      const threshold = this.contextWindow * 0.9;
      let splitIndex = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          // JSONL message entries store usage under entry.message.usage (not top-level entry.usage)
          const usage = entry.type === 'message' ? entry.message?.usage : undefined;
          if (typeof usage?.input === 'number' && usage.input < threshold) {
            splitIndex = i;
            break;
          }
        } catch {
          // skip malformed lines
        }
      }

      if (splitIndex === -1) {
        console.log('[AgentHost] Context overflow: no safe split point found');
        return false;
      }

      // Step 3: Split into head and tail
      const headLines = lines.slice(0, splitIndex + 1);
      tailLines = lines.slice(splitIndex + 1);
      console.log(
        `[AgentHost] Context overflow: split at line ${splitIndex + 1}, tail has ${tailLines.length} entries`
      );

      // Step 4: Truncate file to head
      writeFileSync(activeFile, `${headLines.join('\n')}\n`, 'utf-8');
      fileTruncated = true;

      // Step 5: Reinitialize from truncated file
      await this.reinitializeWithProvider(this.currentProvider, null);

      // Step 6: Compact to reduce head context to ~5%
      if (this.session) {
        console.log('[AgentHost] Context overflow: compacting...');
        await this.session.compact();
        // Synthesize auto_compaction_end so the pruning counter stays accurate
        this.handleCompactionTracking({
          type: 'auto_compaction_end',
        } as AgentSessionEvent);
        console.log('[AgentHost] Context overflow: compaction complete');
      }

      // Step 7: Append tail and reinitialize — session loads compact summary + tail
      if (tailLines.length > 0) {
        appendFileSync(activeFile, `${tailLines.join('\n')}\n`, 'utf-8');
        tailAppended = true;
        console.log('[AgentHost] Context overflow: tail restored, reinitializing...');
        await this.reinitializeWithProvider(this.currentProvider, null);
      }

      console.log('[AgentHost] Context overflow recovery complete');
      // Re-arm guard so future overflows on this session can recover again
      this.contextOverflowHandled = false;
      return true;
    } catch (error) {
      console.error('[AgentHost] Context overflow recovery failed:', error);
      // Best-effort: if the file was truncated but the tail was not yet appended,
      // restore the tail so no history is permanently lost. Skip if tail was
      // already written to avoid duplicating entries.
      if (fileTruncated && !tailAppended && tailLines.length > 0 && activeFile) {
        try {
          appendFileSync(activeFile, `${tailLines.join('\n')}\n`, 'utf-8');
          console.log('[AgentHost] Context overflow: tail restored after recovery failure');
        } catch {
          // Ignore — best-effort only
        }
      }
      return false;
    }
  }
}
