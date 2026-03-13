/**
 * Agent Host
 *
 * Manages the Guide agent session using Pi SDK with JSONL persistence.
 * Includes automatic failover when API errors occur.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
import { parseSessionEntries, rotateSessionIfNeeded } from './session-rotation.js';
import { createBashTool } from './tools/bash.js';
import { createEditTool } from './tools/edit.js';
import { createMessageAgentTool } from './tools/message-agent.js';
import { createReadTool } from './tools/read.js';
import { createReadSystem2DbTool } from './tools/read-system2-db.js';
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
}

export class AgentHost {
  private session: AgentSession | null = null;
  private db: DatabaseClient;
  readonly agentId: number;
  private registry: AgentRegistry;
  private servicesConfig?: ServicesConfig;
  private toolsConfig?: ToolsConfig;
  private spawner?: AgentSpawner;
  private llmConfig: LlmConfig;
  private authResolver: AuthResolver;
  private modelRegistry: ModelRegistry;
  private listeners: Set<(event: AgentSessionEvent) => void> = new Set();
  private currentProvider: LlmProvider;
  private retryAttempts: Map<string, number> = new Map(); // Track retries per error type
  private isReinitializing = false;
  private pendingPrompt: string | null = null;
  private agentRole: string | null = null;
  private agentProject: number | null = null;
  private agentProjectDirName: string | null = null;
  private sessionDir: string | null = null;
  private resourceLoader: DefaultResourceLoader | null = null;
  private busy = false;
  private compactionCount = 0;
  private compactionDepth = 0;
  private isPruning = false;

  constructor(config: AgentHostConfig) {
    this.db = config.db;
    this.agentId = config.agentId;
    this.registry = config.registry;
    this.servicesConfig = config.servicesConfig;
    this.toolsConfig = config.toolsConfig;
    this.spawner = config.spawner;

    // Store LLM config for openai-compatible provider registration
    this.llmConfig = config.llmConfig;

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
    this.agentProject = agentRecord.project ?? null;
    if (this.agentProject !== null) {
      const projectRecord = this.db.getProject(this.agentProject);
      if (projectRecord) {
        this.agentProjectDirName = `${projectRecord.id}_${projectRecord.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')}`;
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
    this.sessionDir = agentSessionDir;

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
    }

    console.log('[AgentHost] Selected model:', modelId, 'for provider:', llmProvider);

    // Find model using registry
    const model = this.modelRegistry.find(llmProvider, modelId);
    if (!model) {
      throw new Error(`Model not found: ${llmProvider}/${modelId}`);
    }

    console.log('[AgentHost] Model found:', model ? 'YES' : 'NO');

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

    // Create session with JSONL persistence - use continueRecent to persist across restarts
    const { session } = await createAgentSession({
      cwd: SYSTEM2_DIR,
      agentDir: SYSTEM2_DIR,
      sessionManager: SessionManager.continueRecent(SYSTEM2_DIR, agentSessionDir),
      authStorage: this.authResolver.createAuthStorage(),
      modelRegistry: this.modelRegistry,
      resourceLoader: this.resourceLoader,
      model,
      customTools: this.buildTools(),
      thinkingLevel: agentConfig.thinking_level ?? 'high',
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
    session.subscribe((event) => {
      // Check for API errors that need failover handling
      this.handlePotentialError(event);

      // Track busy state from agent activity
      if (event.type === 'message_update' || event.type === 'tool_execution_start') {
        if (!this.busy) {
          this.busy = true;
        }
      } else if (event.type === 'agent_end') {
        if (this.busy) {
          this.busy = false;
        }
      }

      // Track compaction for pruning
      this.handleCompactionTracking(event);

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

    // Capture before any await — prompt() may clear it after session.prompt() resolves
    const promptToRetry = this.pendingPrompt;

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
        await this.resourceLoader?.reload();
        await this.session.prompt(promptToRetry);
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
          await this.reinitializeWithProvider(nextProvider, promptToRetry);
          return;
        }
      }

      console.log('[AgentHost] No fallback providers available, error will be surfaced to user');
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
   */
  private async reinitializeWithProvider(
    provider: LlmProvider,
    promptToRetry?: string | null
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
        provider,
        message: `Switched to ${provider} due to API issues`,
      } as AgentSessionEvent;
      this.listeners.forEach((listener) => {
        listener(failoverEvent);
      });

      // Retry the pending prompt with the new provider
      if (promptToRetry && this.session) {
        console.log('[AgentHost] Retrying prompt with new provider...');
        await this.session.prompt(promptToRetry);
      }
    } catch (error) {
      console.error('[AgentHost] Failed to reinitialize:', error);
    } finally {
      this.isReinitializing = false;
    }
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

    // show_artifact is Guide-only — the Guide is the only agent that interacts with the user via the UI
    if (this.agentRole === 'guide') {
      tools.push(createShowArtifactTool(this.db));
    }

    // spawn_agent, terminate_agent, and trigger_project_story require a spawner callback
    // (provided to Guide and Conductors, not Narrator)
    if (this.spawner) {
      tools.push(createSpawnAgentTool(this.db, this.agentId, this.spawner));
      tools.push(createTerminateAgentTool(this.db, this.agentId, this.registry));
      tools.push(createTriggerProjectStoryTool(this.db, this.agentId, this.registry));
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

    // Reload resource loader to pick up knowledge file changes
    await this.resourceLoader?.reload();
    await this.session.prompt(content, promptOptions);
    // Clear on successful completion (no error triggered failover)
    this.pendingPrompt = null;
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

    // Rotate session file if needed (catches growth between server restarts)
    if (this.sessionDir) {
      rotateSessionIfNeeded(this.sessionDir, SYSTEM2_DIR);
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
      // abort() may not trigger agent_end, so clear busy explicitly
      if (this.busy) {
        this.busy = false;
      }
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

  getProvider(): string {
    return this.currentProvider;
  }

  isBusy(): boolean {
    return this.busy;
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
    if (!this.sessionDir) return 0;
    const countFile = join(this.sessionDir, '.compaction-count');
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
    if (!this.sessionDir) return;
    const countFile = join(this.sessionDir, '.compaction-count');
    writeFileSync(countFile, String(count), 'utf-8');
  }

  /**
   * Trigger a pruning compaction that sheds stale information.
   * Uses the Nth oldest compaction summary as a baseline to instruct the LLM
   * to remove information that already existed in the baseline.
   */
  private async triggerPruningCompaction(): Promise<void> {
    if (!this.session || !this.sessionDir) return;

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
    if (!this.session || !this.sessionDir) return null;

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
    const sessionDir = this.sessionDir;
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
}
