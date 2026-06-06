/**
 * Agent Host
 *
 * Manages the Guide agent session using Pi SDK with JSONL persistence.
 * Includes automatic failover when API errors occur.
 */

import { randomUUID } from 'node:crypto';
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
import type { AgentTool } from '@mariozechner/pi-agent-core';
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createReadTool,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';
import matter from 'gray-matter';
import {
  type AgentsConfig,
  DEFAULT_SESSION_ARCHIVE_KEEP_COUNT,
  type LlmConfig,
  type LlmProvider,
  OAUTH_FALLBACKS,
  resolveOAuthModel,
  type ServicesConfig,
  type ThinkingLevel,
  type ToolsConfig,
  validateAgentModels,
} from '../../shared/index.js';
import { MessageHistory } from '../chat/history.js';
import type { DatabaseClient } from '../db/client.js';
import { resolveProjectDir } from '../projects/dir.js'; // used for backfilling dir_name on legacy projects
import type { ReminderManager } from '../reminders/manager.js';
import { NARRATOR_MESSAGE_EXCERPT_BYTES } from '../scheduler/jobs.js';
import { filterByRole } from '../skills/loader.js';
import { log } from '../utils/logger.js';
import type { AuthTier } from './auth-resolver.js';
import { AuthResolver } from './auth-resolver.js';
import { refreshOAuthToken } from './oauth.js';
import type { AgentRegistry } from './registry.js';
import {
  calculateDelay,
  categorizeError,
  type ErrorCategory,
  extractStatusCode,
  isWireSizeOverflow,
  shouldFailover,
  shouldRetry,
  sleep,
} from './retry.js';
import {
  createSessionHeader,
  findMostRecentSession,
  parseSessionEntries,
  pruneArchives,
  rotateSessionIfNeeded,
  writeRotatedFile,
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
import { createCancelReminderTool } from './tools/cancel-reminder.js';
import { createEditTool } from './tools/edit.js';
import { createListRemindersTool } from './tools/list-reminders.js';
import { createMessageAgentTool } from './tools/message-agent.js';
import { createReadSystem2DbTool } from './tools/read-system2-db.js';
import { type AgentResurrector, createResurrectAgentTool } from './tools/resurrect-agent.js';
import { createSetReminderTool } from './tools/set-reminder.js';
import { createShowArtifactTool } from './tools/show-artifact.js';
import { type AgentSpawner, createSpawnAgentTool } from './tools/spawn-agent.js';
import { createTerminateAgentTool } from './tools/terminate-agent.js';
import { createTriggerProjectStoryTool } from './tools/trigger-project-story.js';
import { createWebFetchTool } from './tools/web-fetch.js';
import { createWebSearchTool } from './tools/web-search.js';
import { createWriteTool } from './tools/write.js';
import { createWriteSystem2DbTool, type OnDatabaseWrite } from './tools/write-system2-db.js';
import './types.js'; // Import custom message type declarations

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYSTEM2_DIR = join(homedir(), '.system2');
// Agent files are bundled in the package dist at dist/agents/
const AGENT_DIR = join(__dirname, 'agents');
const AGENT_LIBRARY_DIR = join(AGENT_DIR, 'library');

/** Roles that can spawn, manage, and resurrect agents. Single source of truth for tool access. */
const ORCHESTRATOR_ROLES = new Set(['guide', 'conductor']);

/** Hard cap on inter-agent delivery content. Producers should self-bound; this is the loud-fail
 *  boundary against accidental large deliveries (catch-up payloads, tool result dumps, etc.).
 *  Default ~1 MB ≈ 25% of a 1M-token context window — leaves room for the recipient's system
 *  prompt, history, and knowledge files. Configurable via [delivery] max_bytes in config.toml. */
export const MAX_DELIVERY_BYTES = 1024 * 1024;

/** Cycle-start size that triggers `AgentHost.reclaimBloatedSession`. Above a healthy session
 *  (a header, after the per-tick reset) and below the multi-MB context-overflow point. */
export const SCHEDULED_TASK_SESSION_RECLAIM_BYTES = 2 * 1024 * 1024;

/** Conservative bytes-per-token estimate for bounding the context-overflow recovery tail by size.
 *  Injected `custom_message` deliveries carry no token `usage`, so the usage-based split can't see
 *  them; the byte budget (split-threshold tokens × this) drops a tail that would re-overflow. Low
 *  on purpose — under-counting bytes/token keeps more headroom under the window. */
export const OVERFLOW_TAIL_BYTES_PER_TOKEN = 3;

/** Backstop for an in-flight delivery whose `sendCustomMessage` was invoked but never produced
 *  `agent_end` — guards against silent SDK stream loss. See issue #194. */
export const DELIVERY_DISPATCH_TIMEOUT_MS = 6 * 60 * 1000;

/** Backstop for a delivery sitting deferred in `pendingDeliveries` (never dispatched) — guards
 *  against the wedged-session state where reinit/replay paths never run. See issue #194. */
export const PENDING_DELIVERY_TIMEOUT_MS = 3 * 60 * 1000;

interface AgentDefinition {
  name: string;
  description: string;
  version: string;
  thinking_level?: ThinkingLevel;
  compaction_depth?: number;
  /** When true and a delivery's content starts with `[Scheduled task:`, the agent's session JSONL
   *  is truncated to a fresh session header after `agent_end` for that delivery. Intended for
   *  cron-driven, stateless agents (e.g., Narrator) whose durable memory lives in files
   *  (`daily_summaries/*.md`, `memory.md`, per-project `log.md`) rather than in their session.
   *  Prevents context-overflow loops where each tick's restored session keeps growing. */
  reset_session_after_scheduled_task?: boolean;
  /** Default model per provider for the API-keys tier. The OAuth tier
   *  ignores these — it auto-picks one model per provider via
   *  resolveOAuthModel for all roles. Users override per-role via
   *  `[llm.api_keys.<provider>.models][<role>]` in config.toml.
   *  Only api-keys-tier providers are listed (no github-copilot or
   *  openai-codex, which are OAuth-only). */
  api_keys_models: {
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
  agentsConfig?: AgentsConfig;
  spawner?: AgentSpawner;
  resurrector?: AgentResurrector;
  chatMaxMessages?: number;
  /** Shared AuthResolver for cross-agent rate limit awareness. Falls back to creating a local instance. */
  authResolver?: AuthResolver;
  reminderManager?: ReminderManager;
  knowledgeBudgetChars?: number;
  /** Called after every successful write_system2_db operation. */
  onDatabaseWrite?: OnDatabaseWrite;
  /** Hard cap on inter-agent delivery size in bytes. Defaults to MAX_DELIVERY_BYTES. */
  maxDeliveryBytes?: number;
  /** Per-message excerpt cap for Narrator-bound deliveries in bytes. Defaults to NARRATOR_MESSAGE_EXCERPT_BYTES. */
  narratorMessageExcerptBytes?: number;
  /** Session-rotation threshold in bytes. Defaults to SESSION_FILE_SIZE_LIMIT (10 MB). */
  sessionRotationSizeBytes?: number;
  /** Maximum number of `.jsonl.archived` files to retain per agent's session directory.
   *  Defaults to DEFAULT_SESSION_ARCHIVE_KEEP_COUNT (5). Pruning runs after every successful
   *  rotation (size-based) and after the narrator session-reset path. */
  archiveKeepCount?: number;
  /** When true and a delivery's content starts with `[Scheduled task:`, truncate the agent's
   *  session JSONL to header-only after `agent_end` for that delivery. Sourced from the agent
   *  library frontmatter (`reset_session_after_scheduled_task: true`). Intended for cron-driven,
   *  stateless agents (Narrator) whose durable memory lives in files, not in their session. */
  resetSessionAfterScheduledTask?: boolean;
  /** Called when the agent's busy state changes. */
  onBusyChange?: (agentId: number, busy: boolean, contextPercent: number | null) => void;
  /** Called when an agent is terminated via terminate_agent tool. */
  onAgentTerminate?: () => void;
}

/**
 * Pure helper: pick the model ID for `provider` under the active credential
 * tier. Returns `{ id, autoResolved }` where `autoResolved` is true only when
 * the model came from the OAuth resolver / hardcoded fallback path (no
 * explicit `[llm.oauth.<provider>].model` pin) — gates the 403/404 → fallback
 * hook in handlePotentialError.
 *
 * Resolution order:
 *   - OAuth: user pin → OAUTH_FALLBACKS (if already stepped down) → resolveOAuthModel
 *   - API-keys (most providers): [llm.api_keys.<provider>.models][role] → frontmatter api_keys_models[provider]
 *   - API-keys (openai-compatible): the global `[llm.api_keys.openai-compatible].model`,
 *     since the provider's model isn't in pi-ai's catalog and isn't pinned per-role.
 *     Callers that hand the returned id to a `ModelRegistry` must also call
 *     `registry.registerProvider('openai-compatible', { ... })` first — the
 *     helper returns the id but does not mutate any registry.
 */
export function pickModelForTier(args: {
  tier: AuthTier;
  provider: LlmProvider;
  role: string;
  llmConfig: LlmConfig;
  frontmatterModels: Partial<Record<LlmProvider, string>>;
  fallbackUsedFor: ReadonlySet<LlmProvider>;
}): { id: string | undefined; autoResolved: boolean } {
  const { tier, provider, role, llmConfig, frontmatterModels, fallbackUsedFor } = args;
  if (tier === 'oauth') {
    // `oauth.providers` is keyed by OAuthProvider (the narrowed subset);
    // `provider` here is LlmProvider. Index via a typed cast: if the active
    // provider isn't in OAUTH_PROVIDER_IDS the lookup just returns undefined,
    // which is the correct fall-through (no user pin → resolver path below).
    const userPin =
      llmConfig.oauth?.providers[provider as keyof NonNullable<typeof llmConfig.oauth>['providers']]
        ?.model;
    if (userPin) return { id: userPin, autoResolved: false };
    if (fallbackUsedFor.has(provider)) {
      return { id: OAUTH_FALLBACKS[provider], autoResolved: true };
    }
    return { id: resolveOAuthModel(provider), autoResolved: true };
  }
  // openai-compatible's model is configured globally under
  // `[llm.api_keys.openai-compatible].model`, not per-role and not in
  // pi-ai's catalog. Per-role pins / frontmatter don't apply.
  if (provider === 'openai-compatible') {
    return { id: llmConfig.providers['openai-compatible']?.model, autoResolved: false };
  }
  const id =
    llmConfig.providers[provider]?.models?.[role] ??
    frontmatterModels[provider as keyof typeof frontmatterModels];
  return { id, autoResolved: false };
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
  /** Set by Server via setHistoryFlushHook so WebSocketHandler can commit the
   *  in-flight assistant draft to chatCache before pushing a steering user row. */
  private historyFlushHook: (() => void) | null = null;
  private currentProvider: LlmProvider;
  private currentKeyIndex = 0;
  private currentTier: AuthTier = 'api_keys';
  private retryAttempts: Map<string, number> = new Map(); // Track retries per error type
  private isReinitializing = false;
  private pendingPrompt: string | null = null;
  private pendingDeliveries: Array<{
    content: string;
    details: { sender: number; receiver: number; timestamp: number };
    urgent?: boolean;
    /** True when `content` starts with `[Scheduled task:`. Set at deliverMessage() time and
     *  read in handleSessionEvent() on `agent_end` to decide whether to reset session JSONL. */
    scheduledTask?: boolean;
    /** True when the delivery is queued but `sendCustomMessage` has NOT been called yet —
     *  set by the scheduled-task gate in deliverMessage when another delivery is already
     *  in flight. Cleared by replayPendingDeliveries when the deferred item is finally
     *  sent. Lets the dispatcher distinguish "needs sending" from "sent, waiting for
     *  agent_end to shift". See GitHub issue #189. */
    deferred?: boolean;
    /** Wedge-state watchdog (PR-C layer of issue #194). Cleared when the entry is
     *  dispatched or when resolve/reject fire (those are wrapped at push time). */
    deferTimerHandle?: NodeJS.Timeout;
    /** SDK-stream-loss watchdog (PR-B layer of issue #194). Cleared on settlement. */
    dispatchTimerHandle?: NodeJS.Timeout;
    resolve: () => void;
    reject: (reason: Error) => void;
  }> = [];
  private agentRole: string | null = null;
  private agentProject: number | null = null;
  private agentProjectDirName: string | null = null;
  private _sessionDir: string | null = null;
  private _chatCache: MessageHistory | null = null;
  private chatMaxMessages: number;
  private resourceLoader: DefaultResourceLoader | null = null;
  private busy = false;
  private lastTurnErrored = false;
  /** Providers whose OAuth refresh-and-retry has already been attempted this
   *  delivery. Tracked per-provider so a refresh-retry on one OAuth provider
   *  doesn't suppress a different provider's chance to refresh-retry on a
   *  later 401. Cleared on successful delivery (see agent_end). */
  private oauthRefreshAttemptedFor: Set<LlmProvider> = new Set();
  /** True when the active OAuth model was NOT explicitly user-pinned in
   *  [llm.oauth.<provider>].model — i.e., it came from resolveOAuthModel or
   *  from OAUTH_FALLBACKS after a prior 403/404 step-down. Gates the 403/404
   *  → fallback hook so explicit user pins fail loudly. */
  private oauthAutoResolved = false;
  /** Per-provider record of which OAuth credentials have already stepped down
   *  to OAUTH_FALLBACKS this session. One step-down per provider; restart
   *  re-tries the family flagship. */
  private oauthFallbackUsedFor: Set<LlmProvider> = new Set();
  private deliverySendCount = 0;
  /** True once the model has emitted real output during the current turn —
   *  token streaming (`message_update`) or tool execution (`tool_execution_start`).
   *  Reset on turn_start and agent_end. Read in handlePotentialError to decide
   *  whether resending the in-flight delivery is safe: a contaminated turn may
   *  have already triggered tool side effects (e.g. file edits), so re-feeding it
   *  to the model would duplicate work. See GitHub issue #175.
   *
   *  Notably does NOT flip on `message_start` (#192). That event fires when a
   *  message scaffold is created, including for user messages and for assistant
   *  streams that close with an auth failure before any tokens arrive. Treating
   *  it as "output emitted" caused Anthropic streaming 401s to be dropped by the
   *  contamination guard before the failover path could surface a user-visible
   *  re-auth hint. Real side-effect risk only exists once content streams or a
   *  tool starts executing. */
  private currentTurnHasOutput = false;
  /** True once handlePotentialError has observed a scheduled-task delivery in
   *  pendingDeliveries during the current turn. Read at agent_end to extend the
   *  post-scheduled-task session reset to error turns: without this, a failed
   *  cron tick on a reset-opted-in role leaves the session bloated and every
   *  subsequent tick grows it further (handleContextOverflow cannot find a safe
   *  split point at that size). Reset on turn_start and after agent_end consumes
   *  it. See GitHub issue #189. */
  private hadScheduledTaskDeliveryThisTurn = false;
  private compactionCount = 0;
  private compactionDepth = 0;
  private isPruning = false;
  private deferredAgentEnd: AgentSessionEvent | null = null;
  private pruningGeneration = 0;
  private contextWindow = 0;
  private contextOverflowHandled = false;
  private agentModels: Record<string, string> = {};
  private agentsConfig?: AgentsConfig;
  private reminderManager?: ReminderManager;
  private knowledgeBudgetChars: number;
  private narratorMessageExcerptBytes: number;
  private unsubscribeSession: (() => void) | null = null;
  private onDatabaseWrite?: OnDatabaseWrite;
  private onBusyChange?: (agentId: number, busy: boolean, contextPercent: number | null) => void;
  private onAgentTerminate?: () => void;
  private maxDeliveryBytes: number;
  private sessionRotationSizeBytes: number | undefined;
  /** Reclaim threshold for `reclaimBloatedSession()`; instance-level so tests can lower it. */
  private scheduledTaskSessionReclaimBytes: number = SCHEDULED_TASK_SESSION_RECLAIM_BYTES;
  private archiveKeepCount: number;
  private resetSessionAfterScheduledTask: boolean;
  /** True when the constructor caller passed `resetSessionAfterScheduledTask` explicitly (true OR
   *  false). Used in initialize() to decide whether to consult the agent library frontmatter. We
   *  cannot rely on the boolean field alone because `false` and "unset" are indistinguishable —
   *  without this flag, a caller passing `false` to disable a role's frontmatter `true` would be
   *  silently overridden right back. */
  private resetSessionAfterScheduledTaskOverridden: boolean;

  constructor(config: AgentHostConfig) {
    this.db = config.db;
    this.agentId = config.agentId;
    this.registry = config.registry;
    this.servicesConfig = config.servicesConfig;
    this.toolsConfig = config.toolsConfig;
    this.agentsConfig = config.agentsConfig;
    this.spawner = config.spawner;
    this.resurrector = config.resurrector;
    this.chatMaxMessages = config.chatMaxMessages ?? 1000;
    this.reminderManager = config.reminderManager;
    this.knowledgeBudgetChars = Math.max(config.knowledgeBudgetChars ?? 20_000, 5_000);
    this.narratorMessageExcerptBytes =
      config.narratorMessageExcerptBytes ?? NARRATOR_MESSAGE_EXCERPT_BYTES;
    this.onDatabaseWrite = config.onDatabaseWrite;
    this.onBusyChange = config.onBusyChange;
    this.onAgentTerminate = config.onAgentTerminate;
    this.maxDeliveryBytes = config.maxDeliveryBytes ?? MAX_DELIVERY_BYTES;
    this.sessionRotationSizeBytes = config.sessionRotationSizeBytes;
    this.archiveKeepCount = config.archiveKeepCount ?? DEFAULT_SESSION_ARCHIVE_KEEP_COUNT;
    // Caller-provided override; otherwise initialize() reads it from the agent library frontmatter
    // (`reset_session_after_scheduled_task` field). Default false: only opted-in roles reset.
    // Track override-presence separately so a caller passing `false` (to disable a role's
    // frontmatter `true`) is distinguishable from "caller did not specify".
    this.resetSessionAfterScheduledTaskOverridden =
      config.resetSessionAfterScheduledTask !== undefined;
    this.resetSessionAfterScheduledTask = config.resetSessionAfterScheduledTask ?? false;

    // Store LLM config for openai-compatible provider registration
    this.llmConfig = config.llmConfig;

    // Use shared AuthResolver if provided, otherwise create a local one
    this.authResolver = config.authResolver ?? new AuthResolver(config.llmConfig);
    const authStorage = this.authResolver.createAuthStorage();
    this.modelRegistry = ModelRegistry.create(authStorage);
    const activeCred = this.authResolver.getActiveCredential();
    this.currentProvider = activeCred?.provider ?? this.authResolver.primaryProvider;
    this.currentKeyIndex = activeCred?.keyIndex ?? 0;
    this.currentTier = activeCred?.tier ?? 'api_keys';

    log.info('[AgentHost] Auth status:', this.authResolver.getStatus());
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
        if (projectRecord.dir_name) {
          this.agentProjectDirName = projectRecord.dir_name;
        } else {
          // Legacy fallback: project created before dir_name was tracked
          const projectsDir = join(SYSTEM2_DIR, 'projects');
          const projectDir = resolveProjectDir(projectsDir, projectRecord.id, projectRecord.name);
          this.agentProjectDirName = basename(projectDir);
        }
      }
    }
    this.agentRole = agentRecord.role;
    log.info('[AgentHost] Agent:', { id: agentRecord.id, role: agentRecord.role });

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
      const rotated = rotateSessionIfNeeded(
        agentSessionDir,
        SYSTEM2_DIR,
        this.sessionRotationSizeBytes,
        this.archiveKeepCount
      );
      if (rotated) {
        log.info('[AgentHost] Session file rotated to new file');
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

    // Apply per-role overrides from config.toml ([agents.<role>] sections).
    // Config values take precedence over library frontmatter defaults.
    const roleOverride = this.agentsConfig?.[agentRecord.role];
    if (roleOverride) {
      if (roleOverride.thinking_level !== undefined) {
        agentConfig.thinking_level = roleOverride.thinking_level;
      }
      if (roleOverride.compaction_depth !== undefined) {
        agentConfig.compaction_depth = roleOverride.compaction_depth;
      }
    }

    this.agentModels = agentConfig.api_keys_models ?? {};
    // Validate frontmatter (provider, modelId) pairs against pi-ai's catalog.
    validateAgentModels({ [agentRecord.role]: this.agentModels });
    // Source the session-reset flag from the agent library frontmatter unless the constructor
    // caller passed an explicit value. Precedence: explicit caller value (true OR false) wins;
    // otherwise the frontmatter value (default false for unset) governs reset behavior. Gating on
    // an "overridden" flag rather than the boolean itself lets a caller pass `false` to disable a
    // role's frontmatter `true` — without this, `false` would be indistinguishable from "unset".
    if (!this.resetSessionAfterScheduledTaskOverridden) {
      this.resetSessionAfterScheduledTask = agentConfig.reset_session_after_scheduled_task === true;
    }
    // Static parts of the system prompt (loaded once)
    const staticPrompt = `${agentsRefContent}\n\n${agentPrompt}`;

    let llmProvider = this.currentProvider;

    log.info('[AgentHost] Agent config loaded:', {
      name: agentConfig.name,
      api_keys_models: agentConfig.api_keys_models,
      overrides: roleOverride ? Object.keys(roleOverride) : [],
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
      // Try active provider first, then fallback providers in order.
      const providersToTry = [
        llmProvider,
        ...this.authResolver.providerOrder.filter((p) => p !== llmProvider),
      ];

      let resolvedProvider: LlmProvider | undefined;
      let autoResolved = false;
      for (const provider of providersToTry) {
        const result = pickModelForTier({
          tier: this.currentTier,
          provider,
          role: agentRecord.role,
          llmConfig: this.llmConfig,
          frontmatterModels: agentConfig.api_keys_models,
          fallbackUsedFor: this.oauthFallbackUsedFor,
        });
        if (result.id) {
          modelId = result.id;
          resolvedProvider = provider;
          autoResolved = result.autoResolved;
          if (provider !== llmProvider) {
            log.info(
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
      this.oauthAutoResolved = this.currentTier === 'oauth' && autoResolved;
    }

    log.info('[AgentHost] Selected model:', modelId, 'for provider:', llmProvider);

    // Find model using registry
    const model = this.modelRegistry.find(llmProvider, modelId);
    if (!model) {
      throw new Error(`Model not found: ${llmProvider}/${modelId}`);
    }

    log.info('[AgentHost] Model found:', model ? 'YES' : 'NO');

    // Apply OpenRouter provider routing from [llm.openrouter.routing] config.
    // Keys are model ID prefixes, values are upstream provider order arrays.
    if (llmProvider === 'openrouter') {
      const routing = this.llmConfig.providers.openrouter?.routing;
      if (routing) {
        let matchedOrder: string[] | undefined;
        let longestMatch = 0;
        for (const [prefix, order] of Object.entries(routing)) {
          if (modelId.startsWith(prefix) && prefix.length > longestMatch) {
            matchedOrder = order;
            longestMatch = prefix.length;
          }
        }
        if (matchedOrder && matchedOrder.length > 0) {
          model.compat = {
            ...model.compat,
            openRouterRouting: { order: matchedOrder },
          };
          log.info('[AgentHost] OpenRouter routing for', modelId, ':', matchedOrder);
        }
      }
    }

    // Store context window size for overflow recovery
    this.contextWindow = model.contextWindow;

    // Configure auto-compaction to fire at 50% of context window instead of default ~98%.
    // Earlier compaction reduces the chance of hitting per-model token quotas
    // when multiple agents share the same API key.
    const settingsManager = SettingsManager.inMemory({
      compaction: { reserveTokens: Math.floor(model.contextWindow * 0.5) },
    });

    // Create resource loader with custom system prompt.
    // Knowledge files are re-read on every LLM call via reload() before each prompt.
    // Skills are discovered by the SDK from our two directories, then filtered by agent role.
    this.resourceLoader = new DefaultResourceLoader({
      cwd: SYSTEM2_DIR,
      agentDir: SYSTEM2_DIR,
      systemPromptOverride: () => {
        const identity = `\n\n## Your Identity\n\nYour agent ID is **${agentRecord.id}**. Your role is **${agentRecord.role}**.${agentRecord.project != null ? ` Your project ID is **${agentRecord.project}**.` : ''}`;
        return `${staticPrompt}${identity}${this.loadKnowledgeContext()}\n\n---\n\nConversation history follows.`;
      },
      // Suppress SDK default skill directories (~/.pi/agent/skills/, .pi/skills/)
      // but provide our own paths. User dir first for first-wins precedence.
      noSkills: true,
      additionalSkillPaths: [join(SYSTEM2_DIR, 'skills'), join(AGENT_DIR, 'skills')],
      skillsOverride: ({ skills, diagnostics }) => ({
        skills: filterByRole(skills, this.agentRole ?? ''),
        diagnostics,
      }),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await this.resourceLoader.reload();

    // Create session with JSONL persistence.
    // Use open() on the most recent .jsonl (by mtime) if one exists — this tolerates
    // files that lack a valid session header, which continueRecent() would reject and
    // silently replace with a new empty session. Fall back to continueRecent() only
    // when no .jsonl file exists at all (first-time setup).
    // Refresh near-expiry OAuth tokens before snapshotting auth state into the SDK.
    // refreshOAuthToken dispatches to the correct provider-specific handler via pi-ai's
    // registry; server.ts validates that [llm.oauth] only contains providers pi-ai
    // supports.
    try {
      await this.authResolver.ensureFresh({ refresh: refreshOAuthToken });
    } catch (err) {
      log.warn('[AgentHost] OAuth refresh failed during initialize:', err);
      // Fall through with possibly-stale token; SDK will return 401 → handlePotentialError refreshes again.
    }
    // Re-read active credential in case ensureFresh changed which credential is active.
    // Use getActiveKey(provider) to stay scoped to the current provider, not a system-wide credential.
    const cred = this.authResolver.getActiveKey(this.currentProvider);
    if (cred) {
      this.currentTier = cred.tier;
      // currentProvider was already resolved above; only update tier and keyIndex
      this.currentKeyIndex = cred.keyIndex;
    }

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
      log.info(
        `[AgentHost] Compaction pruning enabled: depth=${this.compactionDepth}, count=${this.compactionCount}`
      );
    }

    // Subscribe to session events and forward to listeners
    this.unsubscribeSession = session.subscribe((event) => {
      this.handleSessionEvent(event);
    });

    log.info(`[AgentHost] ${agentRecord.role} agent session initialized with JSONL persistence`);
    log.info('[AgentHost] Using provider:', this.currentProvider);
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
      log.error('[AgentHost] handlePotentialError threw unexpectedly:', err);
    });

    // Track whether the current turn has emitted any model output. Used by
    // handlePotentialError to detect contaminated turns (issue #175).
    //
    // Excludes `message_start`: that fires on scaffold creation (user messages
    // included, and assistant streams that abort before any token arrives), and
    // including it caused Anthropic streaming 401s to be incorrectly classified
    // as contaminated, dropping the failover path's user-visible re-auth hint
    // (GitHub issue #192).
    if (event.type === 'turn_start') {
      this.currentTurnHasOutput = false;
      // Reset the per-turn scheduled-task flag too; handlePotentialError will
      // set it again if the turn errors with a scheduled-task delivery pending.
      // See GitHub issue #189.
      this.hadScheduledTaskDeliveryThisTurn = false;
    } else if (event.type === 'message_update' || event.type === 'tool_execution_start') {
      this.currentTurnHasOutput = true;
    }

    // Track busy state from agent activity
    if (event.type === 'message_update' || event.type === 'tool_execution_start') {
      if (!this.busy) {
        this.busy = true;
        this.onBusyChange?.(this.agentId, true, this.getContextUsage()?.percent ?? null);
      }
    } else if (event.type === 'agent_end') {
      // On error turns, lastTurnErrored is true (set synchronously in
      // handlePotentialError before agent_end fires). Skip cleanup so the
      // failed prompt/delivery stays tracked for retry or failover.
      const wasErroredTurn = this.lastTurnErrored;
      let completedScheduledTask = false;
      if (!this.lastTurnErrored) {
        // Clear pendingPrompt: one agent_end fires after ALL turns (prompt +
        // follow-ups) are processed, so it's always safe to clear here.
        this.pendingPrompt = null;
        // Resolve delivery promises using the send counter. The SDK's
        // agent_end.messages excludes the initial prompt (which is how
        // sendCustomMessage delivers to an idle agent), so counting messages
        // there always under-counts by 1. The send counter tracks how many
        // sendCustomMessage calls completed since the last agent_end.
        const toResolve = Math.min(this.deliverySendCount, this.pendingDeliveries.length);
        for (let i = 0; i < toResolve; i++) {
          const completed = this.pendingDeliveries.shift();
          if (completed) {
            if (completed.scheduledTask) completedScheduledTask = true;
            completed.resolve();
          }
        }
        this.deliverySendCount = 0;
        // Re-arm the OAuth refresh guard so a future 401 on a fresh token can
        // trigger another refresh attempt.
        this.oauthRefreshAttemptedFor.clear();
      }
      this.lastTurnErrored = false;
      // Clear the per-turn output flag at the run boundary, matching its
      // documented lifecycle. turn_start of the next run will reset it too,
      // but resetting here keeps the flag from carrying state across runs in
      // any code path that might inspect it between agent_end and turn_start.
      this.currentTurnHasOutput = false;

      // A scheduled-task attempt this turn either (a) completed successfully and was
      // resolved above, or (b) errored and was rejected by handlePotentialError's
      // contamination/wire-size guards or surfaced as a failover failure. Both cases
      // warrant the post-scheduled-task session reset on opted-in roles: case (a) is
      // the original per-tick-freshness behavior; case (b) breaks the self-reinforcing
      // context-overflow loop described in GitHub issue #189 — without resetting on
      // error, a bloated session can no longer be compacted (handleContextOverflow
      // cannot find a safe split point), and every subsequent cron tick grows it by
      // another ~one-tick's-worth of payload.
      const scheduledTaskAttempted =
        completedScheduledTask || (wasErroredTurn && this.hadScheduledTaskDeliveryThisTurn);
      this.hadScheduledTaskDeliveryThisTurn = false;

      // If this turn attempted a scheduled-task delivery for a role configured to reset,
      // truncate the session JSONL to a fresh header. The Narrator's durable memory lives in
      // files (`daily_summaries/*.md`, `memory.md`, per-project `log.md`) — not in its session
      // — so dropping session state between cron ticks prevents context-overflow loops without
      // losing semantic context. Reset happens after delivery promises have resolved (above) so
      // awaiting callers see success before reinit kicks off.
      //
      // Always reset, even if other deliveries are still queued. The pathological case this
      // feature protects against (e.g. daily-summary + memory-update overlap, or catch-up
      // storms at startup queueing multiple scheduled tasks) is precisely when several
      // deliveries pile up. After reinitialize() resolves, replay the queued deliveries
      // against the fresh session.
      if (scheduledTaskAttempted && this.resetSessionAfterScheduledTask) {
        if (wasErroredTurn) {
          // The error-turn cleanup block above skipped clearing the send counter; the
          // failed sends are abandoned and replayPendingDeliveries will re-send from
          // scratch against the fresh session, so reset to 0 here.
          this.deliverySendCount = 0;
        }
        this.resetSessionToHeader();
        // Reinitialize asynchronously so the next scheduled tick has a live session ready.
        // Errors are surfaced via .catch (logged AND propagated to any deliveries queued during
        // reinit). Cron ticks are 30 min apart so initialize() has plenty of headroom. Using
        // void-and-catch to keep handleSessionEvent synchronous. Set isReinitializing so
        // concurrent deliverMessage() calls queue in pendingDeliveries (rather than rejecting),
        // then clear it in .finally so the next tick is unblocked even if initialize() throws.
        this.isReinitializing = true;
        void this.initialize()
          .then(() => {
            // Replay any deliveries queued while the just-completed scheduled task was running
            // (or that arrived between agent_end and this point). Without replay they would be
            // stranded in pendingDeliveries with the now-fresh session never seeing them.
            this.replayPendingDeliveries('after scheduled-task reset');
          })
          .catch((err) => {
            log.error('[AgentHost] Failed to reinitialize after scheduled-task reset:', err);
            // Reject every pending delivery so their deferred promises don't hang forever —
            // leaving them pending would block any trackJobExecution caller awaiting the
            // delivery (e.g., server.checkNarratorCatchUp). Mirrors the failover path's
            // cleanup in reinitializeWithProvider.
            const rejectError = err instanceof Error ? err : new Error(String(err));
            for (const delivery of this.pendingDeliveries) {
              delivery.reject(rejectError);
            }
            this.pendingDeliveries = [];
            this.deliverySendCount = 0;
          })
          .finally(() => {
            this.isReinitializing = false;
          });
      }

      // Dispatch the next deferred delivery, if any. Scheduled-task deliveries are
      // gated by deliverMessage to serialize one-per-run; this call picks up the next
      // one once the in-flight delivery's turn has ended.
      //
      // Three guards:
      //  - `!wasErroredTurn`: on error turns the failover/reset paths own the queue —
      //    dispatching here would race with reinitializeWithProvider's replay loop or
      //    send to the about-to-be-disposed session.
      //  - `!this.isReinitializing`: failover keeps the old session non-null while
      //    reinitializing, so a non-null session check alone isn't sufficient.
      //  - `pendingDeliveries.some(d => d.deferred)`: prevents test fixtures and chat
      //    turns with no deferred work from accidentally re-sending already-sent items.
      //
      // Copilot raised the first two guards on the 5th review of PR #191; the third
      // came from review #2. See GitHub issue #189.
      if (
        !wasErroredTurn &&
        !this.isReinitializing &&
        this.pendingDeliveries.some((d) => d.deferred)
      ) {
        this.replayPendingDeliveries('after agent_end');
      }

      // Track compaction for pruning. May synchronously schedule pruning,
      // setting isPruning = true.
      this.handleCompactionTracking(event);

      // If pruning was just scheduled, defer the busy clear and agent_end
      // forwarding until pruning completes — otherwise the UI would see
      // ready_for_input before pruning starts, allowing a user prompt to
      // race with the in-flight compaction. If a previous agent_end is
      // already deferred (a rare case where pi-coding-agent fires another
      // agent_end while pruning is in flight), keep the latest event since
      // ready_for_input is idempotent for the WS handler.
      if (this.isPruning) {
        this.deferredAgentEnd = event;
        return;
      }

      if (this.busy) {
        this.busy = false;
        this.onBusyChange?.(this.agentId, false, this.getContextUsage()?.percent ?? null);
      }
    } else {
      // Track compaction for pruning (handles the compaction_end increment
      // path; the agent_end trigger is handled inline above).
      this.handleCompactionTracking(event);
    }

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

    // Don't handle errors while already reinitializing (session setup in progress)
    if (this.isReinitializing) return;

    // Flag this turn as errored so agent_end does not clear pendingPrompt
    // or shift pendingDeliveries. Must be set synchronously (before any await)
    // because agent_end fires synchronously after message_end.
    this.lastTurnErrored = true;

    // Snapshot whether any IN-FLIGHT delivery was a scheduled task BEFORE the
    // contamination guard or any other rejection path empties pendingDeliveries.
    // agent_end uses this to extend the post-scheduled-task session reset to
    // error turns, breaking the self-reinforcing context-overflow loop where a
    // failed cron tick leaves the session bloated and the next tick fails the
    // same way. See GitHub issue #189.
    //
    // Only items at pendingDeliveries[0..deliverySendCount-1] are actually dispatched to
    // sendCustomMessage. Deferred items at the tail (scheduled-task deliveries gated behind
    // an in-flight delivery, marked `deferred: true`) are NOT in flight and must not trigger
    // a reset for an unrelated error (e.g., a chat prompt() failing while a scheduled task
    // waits its turn). This precision was raised by Copilot on the first commit.
    const inFlightHadScheduled = this.pendingDeliveries
      .slice(0, this.deliverySendCount)
      .some((d) => d.scheduledTask);
    if (inFlightHadScheduled) {
      this.hadScheduledTaskDeliveryThisTurn = true;
    }

    const errorMessage = message.errorMessage;
    log.info('[AgentHost] API error detected:', errorMessage);

    // Categorize the error and build human-readable prefix for chat messages
    const category = categorizeError({ message: errorMessage });
    const statusCode = extractStatusCode({ message: errorMessage });
    const label = categoryLabel(category);
    const errorPrefix = statusCode ? `${statusCode} ${label}` : label;
    log.info('[AgentHost] Error category:', category);

    // Get retry key for this error type
    const retryKey = `${this.currentProvider}:${category}`;
    const currentAttempts = this.retryAttempts.get(retryKey) ?? 0;

    // Capture before any await. With lastTurnErrored, agent_end won't clear these
    // on error turns, but we still snapshot for the failover path where
    // reinitializeWithProvider needs the values passed as arguments.
    const promptToRetry = this.pendingPrompt;

    // Drop pending deliveries only on wire-size overflows (413/"request exceeds maximum size",
    // "extra usage is required for long context", etc.). These payloads are too large to
    // transmit regardless of provider — replaying them would just duplicate the failure.
    // Token-window overflows ("input token count exceeds maximum", "maximum context length",
    // "prompt is too long") are RECOVERABLE via compaction and must NOT drop pending
    // deliveries — they should continue through the compaction-and-replay path below.
    if (
      category === 'context_overflow' &&
      isWireSizeOverflow(errorMessage) &&
      this.pendingDeliveries.length > 0
    ) {
      log.warn(
        `[AgentHost] Dropping ${this.pendingDeliveries.length} pending delivery(ies) on wire-size overflow ` +
          `(re-sending oversized message would just duplicate the failure).`
      );
      for (const d of this.pendingDeliveries) {
        d.reject(
          new Error('Delivery dropped: message exceeded wire-size limits across all providers.')
        );
      }
      this.pendingDeliveries = [];
    }

    // Contaminated-turn check (issue #175). If the model emitted any output
    // before the failure, the in-flight delivery may have already triggered
    // tool side effects (e.g. file edits). Resending it would re-run those
    // side effects. Reject all pending deliveries instead and let the caller
    // surface a failure — for scheduled deliveries the next cron tick reads
    // the unchanged `last_narrator_update_ts` and redoes the window from
    // scratch, with the recipient's idempotency check handling whatever
    // partial work landed on disk.
    //
    // Queued-but-not-yet-processed deliveries behind the in-flight one are
    // also rejected for simplicity. The cost is that any caller awaiting them
    // sees a transient error; for scheduled tasks this just means waiting for
    // the next cron tick (~30 min).
    if (this.currentTurnHasOutput && this.pendingDeliveries.length > 0) {
      log.warn(
        `[AgentHost] Turn already emitted output before failure; ` +
          `rejecting ${this.pendingDeliveries.length} pending delivery(ies) ` +
          `instead of resending to avoid duplicate side effects.`
      );
      const contaminationError = new Error(
        `Delivery aborted: API error after model output (${errorMessage})`
      );
      for (const d of this.pendingDeliveries) {
        d.reject(contaminationError);
      }
      this.pendingDeliveries = [];
    }

    const deliveriesToRetry = [...this.pendingDeliveries];
    // Reset the send counter: the failed turn's sends are abandoned.
    // The retry/failover path will re-send and re-increment as needed.
    this.deliverySendCount = 0;

    // OAuth model fallback: when the auto-resolved family flagship returns
    // 403/404 (provider-specific entitlement / "model not found" signals),
    // step down to OAUTH_FALLBACKS[provider] for the rest of the session.
    // Skipped if the user explicitly pinned a model (oauthAutoResolved=false)
    // — explicit pins fail loudly so the user fixes the pin.
    if (
      this.currentTier === 'oauth' &&
      this.oauthAutoResolved &&
      !this.oauthFallbackUsedFor.has(this.currentProvider) &&
      (statusCode === 403 || statusCode === 404)
    ) {
      const fallback = OAUTH_FALLBACKS[this.currentProvider];
      if (fallback) {
        this.oauthFallbackUsedFor.add(this.currentProvider);
        log.warn(
          `[AgentHost] OAuth ${this.currentProvider} returned ${statusCode}; ` +
            `stepping to fallback ${fallback}`
        );
        await this.reinitializeWithProvider(
          this.currentProvider,
          promptToRetry,
          deliveriesToRetry,
          'OAuth model fallback',
          `${statusCode} on ${this.currentProvider} OAuth credential, retrying with ${fallback}`
        );
        return;
      }
    }

    // OAuth refresh-and-retry: 401 from an OAuth-tier credential should refresh once
    // before failing over. Refresh updates in-memory tokens; reinitialize the session
    // so the SDK picks up the new access token.
    //
    // We force-refresh the current provider because the token may have been server-side
    // revoked while still appearing fresh locally (expires far in the future). If the
    // refresh didn't actually happen (provider not in returned set), skip the retry and
    // fall through to standard failover instead of burning a round-trip with the same token.
    // Gate on statusCode === 401 specifically rather than category === 'auth':
    // categorizeError() maps both 401 and 403 to 'auth', but 403s typically signal
    // permission/entitlement issues (e.g., model not available on the user's plan)
    // and re-authentication is not the right fix. The 403/404 OAuth model-step-down
    // path above handles auto-resolved 403s; any 403 that reaches here means
    // either the model is user-pinned or the step-down has already been used.
    if (
      statusCode === 401 &&
      this.currentTier === 'oauth' &&
      !this.oauthRefreshAttemptedFor.has(this.currentProvider)
    ) {
      this.oauthRefreshAttemptedFor.add(this.currentProvider);
      try {
        const refreshed = await this.authResolver.ensureFresh({
          refresh: refreshOAuthToken,
          force: [this.currentProvider],
        });
        if (refreshed.has(this.currentProvider)) {
          log.info('[AgentHost] OAuth token refreshed after 401, retrying via reinitialize');
          await this.reinitializeWithProvider(
            this.currentProvider,
            promptToRetry,
            deliveriesToRetry,
            'OAuth token refreshed',
            `401 on ${this.currentProvider} OAuth credential, refreshed and retrying`
          );
          return;
        }
        // ensureFresh completed but did not refresh the current provider (e.g., the
        // concurrent lock already ran and still couldn't refresh, or the credential
        // disappeared). Fall through to standard failover to avoid a wasted retry.
        log.warn('[AgentHost] OAuth refresh after 401 was a no-op, falling over');
      } catch (refreshErr) {
        log.warn('[AgentHost] OAuth refresh failed after 401, falling over:', refreshErr);
        // Fall through to standard auth-failure handling below
      }
    }

    // If another agent already put our key in cooldown, skip retries and reinitialize.
    // Uses the tracked key index so we check our actual key, not whatever index
    // another agent may have rotated to.
    if (
      this.authResolver.isKeyInCooldown(
        this.currentProvider,
        this.currentKeyIndex,
        this.currentTier
      )
    ) {
      const nextProvider = this.authResolver.getNextProvider();
      if (nextProvider) {
        const reason =
          nextProvider === this.currentProvider
            ? `${errorPrefix}, rotating to next key`
            : `${errorPrefix}, switched to ${nextProvider}`;
        const reauthHint = this.oauthReauthHintFor(
          this.currentProvider,
          this.currentTier,
          statusCode
        );
        // No errorMessage interpolation: the full error text already lives in
        // the "LLM error" system row pushed by history-capture on the same
        // message_end. Embedding it again here would duplicate it in the chat.
        const detail =
          nextProvider === this.currentProvider
            ? `on ${this.currentProvider}, rotating to next key${reauthHint}`
            : `on ${this.currentProvider} (key already in cooldown), switching to ${nextProvider}${reauthHint}`;
        log.info(
          `[AgentHost] Key ${this.currentProvider}:${this.currentKeyIndex} already in cooldown`
        );
        await this.reinitializeWithProvider(
          nextProvider,
          promptToRetry,
          deliveriesToRetry,
          reason,
          detail
        );
        return;
      }
    }

    // Check if we should retry
    if (shouldRetry(category, currentAttempts)) {
      // Nothing left to retry: the contaminated-turn guard above cleared
      // pendingDeliveries and there is no pendingPrompt. Skipping the
      // sleep+retry-budget increment preserves retryAttempts for the next
      // genuine error on this provider/category. We've already passed the
      // cooldown-rotation and OAuth-refresh checks above, so this only
      // short-circuits the now-pointless retry-with-sleep work (#175).
      if (!promptToRetry && deliveriesToRetry.length === 0) {
        return;
      }

      const delay = calculateDelay(currentAttempts);
      log.info(`[AgentHost] Retrying in ${Math.round(delay)}ms (attempt ${currentAttempts + 1})`);

      this.retryAttempts.set(retryKey, currentAttempts + 1);

      // Wait and retry with the same provider
      await sleep(delay);

      // Retry the pending prompt if there is one
      if (promptToRetry && this.session) {
        log.info('[AgentHost] Retrying prompt...');
        // Restore only if nothing newer arrived during sleep — a new prompt() call during the
        // delay would have set pendingPrompt to the newer message; don't overwrite it.
        this.pendingPrompt = this.pendingPrompt ?? promptToRetry;
        try {
          await this.resourceLoader?.reload();
        } catch (reloadErr) {
          log.warn(
            '[AgentHost] Resource reload failed before prompt retry, using cached:',
            reloadErr
          );
        }
        await this.session.prompt(promptToRetry, { streamingBehavior: 'followUp' });
      }

      // Resend ALL pending deliveries (not just the first). The prompt retry
      // above (if any) queued a turn; deliveries queue as follow-ups behind it.
      // Without this, deliveries beyond [0] stay in pendingDeliveries forever
      // and their promises never resolve, blocking trackJobExecution.
      if (deliveriesToRetry.length > 0 && this.session) {
        log.info(
          `[AgentHost] Resending ${deliveriesToRetry.length} pending delivery(ies) after retry...`
        );
        if (!promptToRetry) {
          try {
            await this.resourceLoader?.reload();
          } catch (reloadErr) {
            log.warn(
              '[AgentHost] Resource reload failed before delivery retry, using cached:',
              reloadErr
            );
          }
        }
        const session = this.session;
        for (const d of deliveriesToRetry) {
          // Preserve the deferral gate across retries: an entry that was deferred at
          // error time (scheduled-task gate, FIFO preservation, or reinit-in-flight)
          // must stay deferred. Resending it as in-flight here would dispatch multiple
          // scheduled-task deliveries in a single SDK run — the exact context-window
          // blow-up that #189 was designed to prevent. Once the (legitimately in-flight)
          // resent entries complete their turn, agent_end's replayPendingDeliveries
          // call picks up the still-deferred entries.
          if (d.deferred) {
            this.clearDeliveryTimers(d);
            this.armDeferTimer(d);
            continue;
          }
          this.deliverySendCount++;
          this.clearDeliveryTimers(d);
          this.armDispatchTimer(d, session);
          session
            .sendCustomMessage(
              {
                customType: 'agent_message',
                content: d.content,
                display: false,
                details: d.details,
              },
              {
                deliverAs: d.urgent ? 'steer' : 'followUp',
                triggerTurn: true,
              }
            )
            .catch((error) => {
              if (this.session !== session) return;
              this.deliverySendCount = Math.max(0, this.deliverySendCount - 1);
              log.error('[AgentHost] Failed to resend delivery after retry:', error);
              const idx = this.pendingDeliveries.indexOf(d);
              if (idx !== -1) this.pendingDeliveries.splice(idx, 1);
              d.reject(error instanceof Error ? error : new Error(String(error)));
            });
        }
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
        this.currentKeyIndex,
        this.currentTier
      );

      if (hasMore) {
        // Get next available provider
        const nextProvider = this.authResolver.getNextProvider();
        if (nextProvider) {
          if (nextProvider === this.currentProvider) {
            const reason = `${errorPrefix}, rotating to next key`;
            const detail = `on ${this.currentProvider}, rotating to next key${this.oauthReauthHintFor(this.currentProvider, this.currentTier, statusCode)}`;
            log.info(`[AgentHost] Rotating to next key for ${this.currentProvider}`);
            await this.reinitializeWithProvider(
              nextProvider,
              promptToRetry,
              deliveriesToRetry,
              reason,
              detail
            );
          } else {
            // Capture before compactForProvider may mutate this.currentProvider / currentTier
            // (it may call handleContextOverflow which reinitializes the session).
            const fromProvider = this.currentProvider;
            const fromTier = this.currentTier;

            // Proactive context check: compact before failover if the candidate
            // model's context window is smaller than the current token count.
            await this.compactForProvider(nextProvider);

            const reason = `${errorPrefix}, switched to ${nextProvider}`;
            const detail = `on ${fromProvider}, switching to ${nextProvider}${this.oauthReauthHintFor(fromProvider, fromTier, statusCode)}`;
            log.info(`[AgentHost] Failing over from ${fromProvider} to ${nextProvider}`);
            await this.reinitializeWithProvider(
              nextProvider,
              promptToRetry,
              deliveriesToRetry,
              reason,
              detail
            );
          }
          return;
        }
      }

      this.pushSystemMessage(
        `${errorPrefix}, all providers unavailable\n\non ${this.currentProvider}, all providers unavailable${this.oauthReauthHintFor(this.currentProvider, this.currentTier, statusCode)}`
      );
      log.info('[AgentHost] No fallback providers available, error will be surfaced to user');

      // Last-resort context overflow recovery: if all providers were exhausted on a
      // 400 error, the root cause may be context overflow misclassified as a client
      // error (e.g., a provider whose overflow message doesn't match any known pattern).
      // Clear transient cooldowns (auth and rate-limit cooldowns are preserved) and
      // attempt compaction on the primary provider. If recovery succeeds, the session
      // continues with a reduced context instead of staying stuck.
      if (statusCode === 400 && !this.contextOverflowHandled) {
        this.authResolver.clearTransientCooldowns();
        const recoveryProvider = this.authResolver.getNextProvider();
        if (recoveryProvider) {
          log.info(
            `[AgentHost] All providers exhausted on 400; attempting emergency context overflow recovery on ${recoveryProvider}`
          );
          this.contextOverflowHandled = true;
          const recovered = await this.handleContextOverflow(undefined, recoveryProvider);
          if (recovered) {
            this.replayAfterContextOverflow();
            return;
          }
          // Recovery failed — reset guard so a future overflow can try again
          this.contextOverflowHandled = false;
        }
      }
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
        this.replayAfterContextOverflow();
        return;
      }
      // Recovery was a no-op — reset guard so a future overflow can try again
      this.contextOverflowHandled = false;
    }

    // Last resort: if a different provider is available (e.g., primary came out of cooldown),
    // switch to it. This covers cases like being stuck on a dead fallback provider.
    const nextProvider = this.authResolver.getNextProvider();
    if (nextProvider && nextProvider !== this.currentProvider) {
      // Capture before compactForProvider may mutate this.currentProvider / currentTier
      const fromProvider = this.currentProvider;
      const fromTier = this.currentTier;

      // Proactive context check before last-resort failover
      await this.compactForProvider(nextProvider);

      const reason = `${errorPrefix}, switched to ${nextProvider}`;
      const detail = `on ${fromProvider}, switching to ${nextProvider}${this.oauthReauthHintFor(fromProvider, fromTier, statusCode)}`;
      log.info(`[AgentHost] Recovery: switching from ${fromProvider} to ${nextProvider}`);
      await this.reinitializeWithProvider(
        nextProvider,
        promptToRetry,
        deliveriesToRetry,
        reason,
        detail
      );
      return;
    }

    // All recovery paths exhausted; ensure busy is cleared
    if (this.busy) {
      this.busy = false;
      this.onBusyChange?.(this.agentId, false, this.getContextUsage()?.percent ?? null);
    }

    // Permanently failed: reject all pending delivery promises
    for (const delivery of this.pendingDeliveries) {
      delivery.reject(new Error(`All providers exhausted: ${errorMessage}`));
    }
    this.pendingDeliveries = [];

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
    deliveriesToRetry?: Array<{
      content: string;
      details: { sender: number; receiver: number; timestamp: number };
      urgent?: boolean;
      scheduledTask?: boolean;
      deferred?: boolean;
      resolve: () => void;
      reject: (reason: Error) => void;
    }>,
    reason?: string,
    detail?: string
  ): Promise<void> {
    if (this.isReinitializing) {
      log.info('[AgentHost] Already reinitializing, skipping');
      return;
    }

    this.isReinitializing = true;
    log.info(`[AgentHost] Reinitializing with provider: ${provider}`);

    // Old session is dead; clear busy so the agent doesn't appear stuck
    if (this.busy) {
      this.busy = false;
      this.onBusyChange?.(this.agentId, false, this.getContextUsage()?.percent ?? null);
    }

    // Drop any pruning state tied to the dead session: a deferred agent_end
    // belongs to a session that no longer exists, and isPruning would otherwise
    // remain true if the in-flight session.compact() never resolves. Bump
    // pruningGeneration so the stale promise's .finally is a no-op and can't
    // race with a fresh pruning started after reinit completes.
    this.deferredAgentEnd = null;
    this.isPruning = false;
    this.pruningGeneration++;

    try {
      // Update current provider and key index
      this.currentProvider = provider;
      this.currentKeyIndex = this.authResolver.getActiveKey(provider)?.keyIndex ?? 0;
      this.currentTier = this.authResolver.getActiveKey(provider)?.tier ?? 'api_keys';

      // Push chat message before init so the user sees the reason even if
      // initialization fails. Only for actual failovers, not compaction recovery.
      if (reason) {
        this.pushSystemMessage(detail ? `${reason}\n\n${detail}` : reason);
      }

      try {
        await this.authResolver.ensureFresh({ refresh: refreshOAuthToken });
      } catch (err) {
        log.warn('[AgentHost] OAuth refresh failed during reinitialize:', err);
      }

      // Recreate model registry with updated auth
      const authStorage = this.authResolver.createAuthStorage();
      this.modelRegistry = ModelRegistry.create(authStorage);

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

      // Snapshot the "queued-while-reinitializing" set BEFORE clearing the flag. Anything in
      // pendingDeliveries right now that is NOT in the pre-failover snapshot was pushed by a
      // concurrent deliverMessage() call that took the queue-during-reinit branch (issue #169).
      // We must replay these, but only these — deliveries that arrive AFTER we clear the flag
      // will go through the normal send path (because session is now non-null and the flag is
      // false) and would be sent twice if we recomputed this set after the await below.
      const retrySnapshot = deliveriesToRetry ?? [];
      const queuedDuringReinit = this.pendingDeliveries.filter((d) => !retrySnapshot.includes(d));
      const toReplay = [...retrySnapshot, ...queuedDuringReinit];

      // Re-arm error handling before retrying the prompt. Errors from the new
      // provider need normal failover, not the isReinitializing early-return.
      this.isReinitializing = false;
      // Reset the send counter: old session's sends are gone, new session starts fresh
      this.deliverySendCount = 0;

      // Replay BEFORE the prompt retry to preserve the FIFO invariant that
      // handleSessionEvent's shift logic depends on (Copilot round 3, PR #170). The replay loop
      // is synchronous (it starts async sendCustomMessage calls but doesn't await), so it
      // populates deliverySendCount and leaves the backlog entries at the front of
      // pendingDeliveries BEFORE any await yields control. If the replay ran AFTER the prompt
      // await, a concurrent deliverMessage() arriving during the await would land at
      // deliverySendCount=1 with backlog entries still at the front of pendingDeliveries —
      // agent_end would then shift a backlog entry and resolve its promise early, while the
      // replay would re-send the backlog entry to the agent (duplicate processing).
      //
      // Uses sendCustomMessage directly (not deliverMessage) to avoid duplicating chat cache
      // entries already added by the original delivery. Iterates the pre-clear snapshot, NOT
      // live pendingDeliveries — entries pushed during the prompt-retry await below go through
      // the normal send path and must not be replayed.
      if (toReplay.length > 0 && this.session) {
        log.info(
          `[AgentHost] Replaying ${toReplay.length} pending delivery(ies) with new provider ` +
            `(${retrySnapshot.length} pre-reinit, ${queuedDuringReinit.length} during reinit)...`
        );
        const session = this.session;
        // Scheduled-task gate also applies here: without it, a failover that happens with
        // multiple scheduled-task deliveries queued (e.g., daily-summary's 3 messages) would
        // batch them as Pi SDK followUp turns in one run on the new session, reintroducing
        // the within-tick prompt bloat that the gate in deliverMessage is designed to prevent.
        // Subsequent scheduled-tasks get marked `deferred` so agent_end's dispatch picks them
        // up after the in-flight one's turn ends. And once anything is deferred, ALL
        // subsequent items must be deferred too (chat or not) to keep the invariant that
        // pendingDeliveries[0..deliverySendCount-1] is exactly the in-flight prefix —
        // agent_end's shift and hadScheduledTaskDeliveryThisTurn's slice both depend on it.
        // Copilot reviews #2 and #3 raised these on PR #191.
        let scheduledTaskSent = false;
        let anyDeferred = false;
        for (const d of toReplay) {
          // Respect pre-existing deferred flag: items that were gate-blocked before failover
          // (e.g., a scheduled task deferred behind an in-flight chat) must remain deferred
          // here, otherwise they'd be sent inline as a followUp on the new session and the
          // gate semantics would be lost. Self-review #1 on PR #191.
          if (d.deferred || anyDeferred || (d.scheduledTask && scheduledTaskSent)) {
            d.deferred = true;
            anyDeferred = true;
            // toReplay may contain items that have been removed from pendingDeliveries (e.g.,
            // a rejected stale send); re-add so the agent_end dispatch path can find them.
            if (!this.pendingDeliveries.includes(d)) {
              this.pendingDeliveries.push(d);
            }
            // Old timers (if any) belong to the pre-failover session; re-arm the wedge
            // watchdog against the new session's reinit/replay timeline.
            this.clearDeliveryTimers(d);
            this.armDeferTimer(d);
            continue;
          }
          // Increment count synchronously so agent_end (which fires before
          // sendCustomMessage resolves for idle agents) sees the correct tally.
          this.deliverySendCount++;
          d.deferred = false;
          if (d.scheduledTask) scheduledTaskSent = true;
          this.clearDeliveryTimers(d);
          this.armDispatchTimer(d, session);
          session
            .sendCustomMessage(
              {
                customType: 'agent_message',
                content: d.content,
                display: false,
                details: d.details,
              },
              {
                deliverAs: d.urgent ? 'steer' : 'followUp',
                triggerTurn: true,
              }
            )
            .catch((error) => {
              if (this.session !== session) return;
              this.deliverySendCount = Math.max(0, this.deliverySendCount - 1);
              log.error('[AgentHost] Failed to replay delivery after failover:', error);
              const idx = this.pendingDeliveries.indexOf(d);
              if (idx !== -1) this.pendingDeliveries.splice(idx, 1);
              d.reject(error instanceof Error ? error : new Error(String(error)));
              // Release the gate after a failed send (no agent_end will fire for it).
              if (this.pendingDeliveries.some((x) => x.deferred)) {
                this.replayPendingDeliveries('after failover replay failure');
              }
            });
        }
      }

      // Retry the pending prompt with the new provider AFTER the replay loop has queued its
      // sends. Replays are now at the front of pendingDeliveries with their deliverySendCount
      // accounted for, so a concurrent deliverMessage() during this await lands at the END
      // of pendingDeliveries (FIFO preserved).
      if (promptToRetry && this.session) {
        log.info('[AgentHost] Retrying prompt with new provider...');
        // Restore only if nothing newer arrived during reinitialization.
        this.pendingPrompt = this.pendingPrompt ?? promptToRetry;
        await this.session.prompt(promptToRetry, { streamingBehavior: 'followUp' });
      }
    } catch (error) {
      log.error('[AgentHost] Failed to reinitialize:', error);
      if (reason) {
        const msg = error instanceof Error ? error.message : String(error);
        this.pushSystemMessage(`Failed to switch provider\n\n${msg}`);
      }
      // Reject all pending deliveries so their promises don't hang forever
      // (which would leave trackJobExecution stuck in "running" state).
      const rejectError =
        error instanceof Error ? error : new Error(`Reinitialize failed: ${String(error)}`);
      for (const d of this.pendingDeliveries) {
        d.reject(rejectError);
      }
      this.pendingDeliveries = [];
      this.deliverySendCount = 0;
    } finally {
      this.isReinitializing = false;
    }
  }

  /** Returns a user-facing re-auth hint when an OAuth credential is the
   *  one being surfaced as failing. Three gates:
   *    - The failing tier is 'oauth' (so an API-key 401 for the same provider
   *      does not inherit OAuth refresh state — cooldowns are tier-namespaced
   *      in AuthResolver, and failover from OAuth to api_keys for the same
   *      provider is a real scenario).
   *    - The current error is a 401 (categorizeError maps both 401 and 403
   *      to 'auth' but 403 typically signals permission/entitlement, where
   *      re-authentication is not the fix).
   *    - The provider's refresh-and-retry has already been attempted this
   *      delivery (so we don't show the hint on the first 401, only after
   *      the automatic recovery path has been used). */
  private oauthReauthHintFor(
    provider: LlmProvider,
    tier: AuthTier,
    statusCode: number | undefined
  ): string {
    return tier === 'oauth' && statusCode === 401 && this.oauthRefreshAttemptedFor.has(provider)
      ? `\n\nRun \`system2 config\` to refresh ${provider} authentication and restart the server.`
      : '';
  }

  /** Push a system-role message into the chat cache (visible in UI history). */
  private pushSystemMessage(content: string): void {
    if (!this._chatCache) return;
    this._chatCache.push({
      // randomUUID, not msg-${Date.now()}: dedup-by-id in the UI's appendMessage
      // makes id uniqueness load-bearing — failover rows often fire close
      // together (e.g. refresh-then-failover) and millisecond ids would collide.
      id: `msg-${randomUUID()}`,
      role: 'system',
      content,
      timestamp: Date.now(),
    });
  }

  /**
   * Load knowledge files and return as context string for the system prompt.
   * Empty files (0 lines) are skipped. Files exceeding the knowledge budget are
   * truncated at the tail.
   */
  private loadKnowledgeContext(): string {
    const MAX_KNOWLEDGE_CHARS = this.knowledgeBudgetChars;
    const knowledgeDir = join(SYSTEM2_DIR, 'knowledge');
    const sections: string[] = [];

    const readWithBudget = (filePath: string): string => {
      const raw = readFileSync(filePath, 'utf-8');
      if (raw.length <= MAX_KNOWLEDGE_CHARS) return raw;
      return (
        raw.slice(0, MAX_KNOWLEDGE_CHARS) +
        `\n\n[...truncated: file exceeds ${MAX_KNOWLEDGE_CHARS.toLocaleString()} char budget]`
      );
    };

    const addSection = (filePath: string, content: string) => {
      if (content.trim().split('\n').length > 0) {
        const label = filePath.replace(homedir(), '~').replace(/\\/g, '/');
        sections.push(`### ${label}\n\n${content.trim()}`);
      }
    };

    for (const file of ['infrastructure.md', 'user.md', 'memory.md']) {
      const filePath = join(knowledgeDir, file);
      if (existsSync(filePath)) {
        addSection(filePath, readWithBudget(filePath));
      }
    }

    // Role-specific knowledge file (guide.md, conductor.md, narrator.md, reviewer.md)
    const roleKnowledgePath = join(knowledgeDir, `${this.agentRole}.md`);
    if (existsSync(roleKnowledgePath)) {
      addSection(roleKnowledgePath, readWithBudget(roleKnowledgePath));
    }

    // Role-aware activity context:
    // Project-scoped agents get their project log; system-wide agents get daily summaries.
    // Activity logs are chronologically appended, so we keep the newest content (tail) and
    // drop the oldest middle when truncation is needed — the opposite of curated files.
    if (this.agentProject !== null && this.agentProjectDirName) {
      const projectLogPath = join(SYSTEM2_DIR, 'projects', this.agentProjectDirName, 'log.md');
      if (existsSync(projectLogPath)) {
        addSection(
          projectLogPath,
          this.readActivityLogWithBudget(projectLogPath, MAX_KNOWLEDGE_CHARS)
        );
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
          addSection(filePath, this.readActivityLogWithBudget(filePath, MAX_KNOWLEDGE_CHARS));
        }
      }
    }

    if (sections.length === 0) return '';
    return `\n\n## Knowledge Base\n\n${sections.join('\n\n---\n\n')}`;
  }

  /**
   * Truncate an activity-log file (chronologically appended) keeping the YAML frontmatter
   * and the newest trailing content. Drops the oldest middle content with a marker.
   */
  private readActivityLogWithBudget(filePath: string, budget: number): string {
    const raw = readFileSync(filePath, 'utf-8');
    if (raw.length <= budget) return raw;

    let frontmatter = '';
    let body = raw;
    const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n/);
    if (fmMatch) {
      frontmatter = fmMatch[0];
      body = raw.slice(fmMatch[0].length);
    }

    const notice = `\n\n[...truncated: dropped oldest content from this activity log to fit ${budget.toLocaleString()}-char budget; newest entries below]\n\n`;
    const tailBudget = budget - frontmatter.length - notice.length;
    if (tailBudget <= 0) {
      // Frontmatter alone exceeds budget; degenerate case
      return (
        raw.slice(0, budget) +
        `\n\n[...truncated: file exceeds ${budget.toLocaleString()} char budget]`
      );
    }

    const tail = body.slice(-tailBudget);
    return frontmatter + notice + tail;
  }

  /**
   * Build the custom tools array, conditionally including web_search if configured.
   */
  private buildTools() {
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool collection matches SDK's AgentTool<any>[]
    const tools: AgentTool<any>[] = [
      createReadSystem2DbTool(this.db),
      createWriteSystem2DbTool(this.db, this.agentId, this.onDatabaseWrite),
      createMessageAgentTool(this.agentId, this.registry, this.db, this.maxDeliveryBytes),
      createBashTool(
        (content, details) => {
          this.session?.sendCustomMessage(
            { customType: 'bash_background', content, display: false, details },
            { deliverAs: 'followUp', triggerTurn: true }
          );
        },
        {
          sessionDir: this._sessionDir ?? undefined,
          maxInlineOutputBytes: this.toolsConfig?.bash?.max_inline_output_bytes,
        }
      ),
      // pi-ai's read tool. Resolves relative paths against homedir() to
      // mirror the legacy system2 read tool's semantics; gains offset/limit
      // slicing, 2,000-line / 50 KB truncation with "use offset=N to continue"
      // hints, image auto-resize for vision models, AbortSignal support, and
      // a `bash: sed -n 'Np' file | head -c N` fallback when a single line
      // exceeds the byte cap. Pairs with bash.ts's output-cap-to-file pattern:
      // when bash saves a large output, the agent reads slices of the saved
      // file via offset/limit here.
      createReadTool(homedir(), { autoResizeImages: true }),
      createEditTool(),
      createWriteTool(),
    ];

    // Narrator is a background narration agent: it reads files and writes summaries.
    // It has no use for web access, artifact display, or reminders.
    const isNarrator = this.agentRole === 'narrator';

    if (!isNarrator) {
      tools.push(createWebFetchTool());
    }

    // web_search requires a Brave Search API key
    const braveKey = this.servicesConfig?.brave_search?.key;
    if (!isNarrator && braveKey && this.toolsConfig?.web_search?.enabled !== false) {
      tools.push(createWebSearchTool(braveKey, this.toolsConfig?.web_search?.max_results));
      log.info('[AgentHost] web_search tool enabled');
    }

    if (!isNarrator) {
      tools.push(createShowArtifactTool(this.db));
    }

    if (!isNarrator && this.reminderManager) {
      tools.push(createSetReminderTool(this.agentId, this.reminderManager));
      tools.push(createCancelReminderTool(this.agentId, this.reminderManager));
      tools.push(createListRemindersTool(this.agentId, this.reminderManager));
    }

    // Guide and Conductor only: spawn, manage, and resurrect agents
    const canOrchestrate = this.agentRole !== null && ORCHESTRATOR_ROLES.has(this.agentRole);

    if (canOrchestrate && this.spawner) {
      tools.push(createSpawnAgentTool(this.db, this.agentId, this.spawner));
      tools.push(
        createTerminateAgentTool(this.db, this.agentId, this.registry, this.onAgentTerminate)
      );
      tools.push(
        createTriggerProjectStoryTool(
          this.db,
          this.agentId,
          this.registry,
          this.narratorMessageExcerptBytes
        )
      );
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
   * Server installs the history-capture's flushPartial here. Called from
   * WebSocketHandler before pushing a steering user message: commits the
   * in-flight assistant draft into chatCache so the persisted order is
   * [assistant_partial, user_steering] instead of the race-prone reverse.
   * After this fires, the SDK's eventual message_end for the interrupted
   * turn finds the history-capture buffers empty and is a no-op for the
   * partial-commit branch.
   */
  setHistoryFlushHook(fn: () => void): void {
    this.historyFlushHook = fn;
  }

  /** Invoke the installed history-capture flush hook (no-op if not wired). */
  flushPartialTurn(): void {
    this.historyFlushHook?.();
  }

  /**
   * Send a message to the agent
   * @param content The message content
   * @param options.isSteering If true, the message is queued as a steering message (inserted ASAP into the agent loop)
   */
  async prompt(content: string, options?: { isSteering?: boolean }): Promise<void> {
    if (this.isReinitializing) {
      throw new Error('Agent is reinitializing, prompt rejected');
    }
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
   * Returns a Promise that resolves when agent_end confirms the delivery was
   * processed, or rejects on permanent failure (all providers exhausted, abort,
   * or send failure). Callers outside agent turns (e.g., scheduler jobs) can
   * await it; callers inside agent turns should NOT await it to avoid deadlocks
   * (sendCustomMessage internally calls agent.prompt() when the receiver is idle).
   *
   * @param content LLM-visible message content (includes sender prefix)
   * @param details Metadata for programmatic use (not sent to LLM)
   * @param urgent If true, uses 'steer' delivery (interrupts mid-turn). Default: 'followUp' (waits for current turn to finish).
   */
  deliverMessage(
    content: string,
    details: { sender: number; receiver: number; timestamp: number },
    urgent?: boolean
  ): Promise<void> {
    // Truly uninitialized — initialize() has never run. This is a caller bug, not a transient
    // race, so reject. Reinit-in-progress (this.session may be null because resetSessionToHeader
    // cleared it) is a different state: it's transient, the new session is on the way, and the
    // replay paths in handleSessionEvent / reinitializeWithProvider will deliver this message
    // against the new session once init completes.
    if (!this.session && !this.isReinitializing) {
      return Promise.reject(
        new Error(
          'AgentHost has no session available (either initialize() has not been called, or a reinit attempt failed)'
        )
      );
    }

    // Check wire-size budget before queuing
    if (Buffer.byteLength(content, 'utf8') > this.maxDeliveryBytes) {
      return Promise.reject(
        new Error(
          `Delivery content exceeds max_bytes (${this.maxDeliveryBytes} bytes). ` +
            `Producer should pre-bound. Receiver=${details.receiver}, sender=${details.sender}.`
        )
      );
    }

    // Create deferred promise for completion notification. Resolves when
    // agent_end confirms the delivery was processed, rejects on permanent
    // failure (all providers exhausted, abort, or send failure).
    //
    // resolve/reject are wrapped so every existing settlement path tears down
    // the watchdog timers automatically; no per-site changes needed (issue #194).
    let baseResolve!: () => void;
    let baseReject!: (reason: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      baseResolve = res;
      baseReject = rej;
    });
    const entry: (typeof this.pendingDeliveries)[number] = {
      content,
      details,
      urgent,
      scheduledTask: content.startsWith('[Scheduled task:'),
      resolve: () => {
        this.clearDeliveryTimers(entry);
        baseResolve();
      },
      reject: (reason: Error) => {
        this.clearDeliveryTimers(entry);
        baseReject(reason);
      },
    };

    // Track for failover retry. If the session is destroyed during reinitialization,
    // queued sendCustomMessage calls are lost. This queue lets handlePotentialError
    // replay them on the new session. Cleared per-turn by agent_end (shift).
    const scheduledTask = entry.scheduledTask;
    this.pendingDeliveries.push(entry);

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
        id: `msg-${randomUUID()}`,
        role: 'system',
        content: cacheContent,
        timestamp: details.timestamp,
      });
    }

    // Gate logic. Four reasons to defer instead of sending now:
    //
    //  (a) Session is being rebuilt (`!this.session || this.isReinitializing`). The
    //      reset/failover replay paths will pick this up against the fresh session.
    //  (b) Scheduled-task gate: don't pile a scheduled-task delivery onto an in-flight
    //      delivery. The Pi SDK treats sendCustomMessage(followUp) on a busy session as a
    //      follow-up turn in the current run, so multiple scheduled-task deliveries would
    //      pile up as follow-ups within one run and each call's input would carry the
    //      prior turns as conversation history. With a ~512 KB per-delivery activity
    //      budget and 3 deliveries per daily-summary tick, by the 3rd call the input
    //      blows the model's 1M-token context window. See GitHub issue #189.
    //  (c) "Scheduled task runs alone" — don't pile a non-scheduled delivery onto a
    //      scheduled-task that's in flight either. Otherwise the chat would share the
    //      scheduled-task's run and the per-run session reset would no longer reflect a
    //      pure scheduled-task turn. Copilot raised this on the 5th review of PR #191.
    //  (d) FIFO preservation: if any unsent (deferred) item is already in the queue,
    //      sending a later arrival immediately would leave the queue with sent items
    //      interleaved between unsent ones, breaking the invariant that the first
    //      `deliverySendCount` items are exactly the ones in flight. agent_end's shift
    //      and `hadScheduledTaskDeliveryThisTurn`'s slice both depend on that invariant.
    //      Copilot review #3 raised this on PR #191.
    //
    // The just-pushed entry is at the end of pendingDeliveries; "unsent items already
    // present" means `length - 1 > deliverySendCount` (the new entry doesn't count itself).
    const reinitInFlight = !this.session || this.isReinitializing;
    const scheduledOnBusy = scheduledTask && this.deliverySendCount > 0;
    const inFlightHasScheduled = this.pendingDeliveries
      .slice(0, this.deliverySendCount)
      .some((d) => d.scheduledTask);
    const hadUnsentBefore = this.pendingDeliveries.length - 1 > this.deliverySendCount;
    if (reinitInFlight || scheduledOnBusy || inFlightHasScheduled || hadUnsentBefore) {
      entry.deferred = true;
      this.armDeferTimer(entry);
      return promise;
    }

    // Reload resource loader to pick up knowledge file changes, then deliver.
    // Reload errors are swallowed so a filesystem hiccup never drops a message.
    // The `reinitInFlight` gate above guarantees this.session is non-null here; using a
    // non-null assertion (rather than a silent guard) so that any future regression that
    // breaks the gate logic surfaces loudly via runtime crash instead of silently dropping
    // the delivery. Self-review #4 on PR #191.
    const session = this.session as NonNullable<typeof this.session>;
    const reload = this.resourceLoader
      ? this.resourceLoader
          .reload()
          .catch((err) => log.warn('[AgentHost] reload failed, using cached knowledge:', err))
      : Promise.resolve();

    // Increment count synchronously so agent_end (which fires before
    // sendCustomMessage resolves for idle agents) sees the correct tally.
    this.deliverySendCount++;
    this.armDispatchTimer(entry, session);
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
      .catch((err) => {
        // If the session changed (failover/reinit), this catch belongs to a
        // stale send. The delivery was already captured in deliveriesToRetry
        // and replayed on the new session — mutating state here would corrupt
        // the new session's deliverySendCount / pendingDeliveries.
        if (this.session !== session) return;
        this.deliverySendCount = Math.max(0, this.deliverySendCount - 1);
        log.error('[AgentHost] deliverMessage error:', err);
        // Send itself failed (session destroyed, etc.). The message never
        // reached the agent, so remove from queue and reject immediately.
        const idx = this.pendingDeliveries.indexOf(entry);
        if (idx !== -1) {
          this.pendingDeliveries.splice(idx, 1);
          entry.reject(
            new Error(`Delivery send failed: ${err instanceof Error ? err.message : String(err)}`)
          );
        }
        // Release the scheduled-task gate: agent_end won't fire for a send that never reached
        // the agent, so without this dispatch any deferred deliveries behind the failed send
        // would sit in the queue forever. Copilot review #2 raised this on PR #191.
        if (this.pendingDeliveries.some((d) => d.deferred)) {
          this.replayPendingDeliveries('after send failure');
        }
      });

    return promise;
  }

  /**
   * Abort current execution
   */
  abort(): void {
    if (this.session) {
      this.session.abort();
      // abort() may not trigger agent_end, so clear busy and pending state explicitly
      if (this.busy) {
        this.busy = false;
        this.onBusyChange?.(this.agentId, false, this.getContextUsage()?.percent ?? null);
      }
      this.pendingPrompt = null;
      this.deliverySendCount = 0;
      for (const delivery of this.pendingDeliveries) {
        delivery.reject(new Error('Agent session aborted'));
      }
      this.pendingDeliveries = [];
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
   * Increments counter only when a compaction actually produced a summary, so
   * silent no-ops (early exits in the SDK's _runAutoCompaction) and failures
   * don't burn the pruning-depth budget.
   */
  private handleCompactionTracking(event: AgentSessionEvent): void {
    if (this.compactionDepth <= 0) return;

    // Track compaction counter — only on real, completed compactions.
    // Using AgentSessionEvent (the SDK's discriminated union) lets TypeScript
    // narrow `event` to the full `compaction_end` shape here, so we can read
    // result/aborted/errorMessage directly without a cast.
    if (
      event.type === 'compaction_end' &&
      event.result != null &&
      !event.aborted &&
      !event.errorMessage
    ) {
      this.bumpCompactionCount();
    }

    // Trigger pruning compaction on agent_end when counter reaches depth
    if (
      event.type === 'agent_end' &&
      this.compactionCount >= this.compactionDepth &&
      !this.isPruning
    ) {
      this.isPruning = true;
      // Capture a generation token so a stale pruning whose session was torn
      // down by reinitializeWithProvider can't clear isPruning or flush the
      // deferred agent_end of a newer pruning that started in the meantime.
      const generation = ++this.pruningGeneration;
      this.triggerPruningCompaction()
        .catch((err: unknown) => log.error('[AgentHost] Pruning compaction error:', err))
        .finally(() => {
          if (this.pruningGeneration !== generation) return;
          this.isPruning = false;
          this.flushDeferredAgentEnd();
        });
    }
  }

  /**
   * Increment the pruning counter and persist it. Called from
   * `handleCompactionTracking` for SDK-driven `compaction_end` events that
   * actually produced a summary, and directly from `handleContextOverflow`
   * after a successful manual `session.compact()` (since the overflow path
   * doesn't go through `handleCompactionTracking` with a real SDK event).
   */
  private bumpCompactionCount(): void {
    this.compactionCount++;
    this.writeCompactionCount(this.compactionCount);
  }

  /**
   * If an agent_end was deferred while pruning was in flight, complete its
   * handling now: clear busy and forward to listeners so the UI receives
   * ready_for_input only after pruning has finished.
   *
   * Compaction tracking already ran inline before deferral, so the counter
   * has been reset by triggerPruningCompaction; no need to re-track here.
   */
  private flushDeferredAgentEnd(): void {
    const deferred = this.deferredAgentEnd;
    if (!deferred) return;
    this.deferredAgentEnd = null;
    if (this.busy) {
      this.busy = false;
      this.onBusyChange?.(this.agentId, false, this.getContextUsage()?.percent ?? null);
    }
    this.listeners.forEach((listener) => {
      listener(deferred);
    });
  }

  /**
   * Truncate the active session JSONL to a fresh session header and clear in-memory session state.
   * Called after `agent_end` for a scheduled-task delivery on roles that opt in via
   * `reset_session_after_scheduled_task: true`.
   *
   * The old JSONL is archived as `<name>.jsonl.archived` for forensic inspection (the active-
   * session scanner only reads files ending in `.jsonl`, so archived files are excluded from
   * subsequent loads). Compaction state is also reset to 0, so baseline lookup will start fresh
   * on the new session — no scanner traversal of older files is needed. The next prompt or
   * delivery sees `this.session === null` and drives reinitialization, which reads the new
   * header-only JSONL.
   *
   * Failures are logged but never thrown: a failed reset must not break the agent. The next cron
   * tick simply runs against the unrotated file and may eventually hit the size-rotation path.
   */
  private resetSessionToHeader(): void {
    const sessionDir = this._sessionDir;
    if (!sessionDir) return;
    const activeFile = findMostRecentSession(sessionDir);
    if (!activeFile) return;

    try {
      // Tear the SDK session down BEFORE renaming the active JSONL. The pi-coding-agent
      // SessionManager uses `appendFileSync(this.sessionFile, ...)` and resolves `sessionFile`
      // up front. After we rename the active file, any further append from the live SDK session
      // would recreate the file at the original path WITHOUT a header — exactly the hazard the
      // existing rotateSessionIfNeeded path warns about. Order: detach our subscription, capture
      // and null the session ref so concurrent paths can't reuse it, then call session.dispose()
      // (which calls _disconnectFromAgent and clears the SDK's internal event listeners).
      if (this.unsubscribeSession) {
        this.unsubscribeSession();
        this.unsubscribeSession = null;
      }
      const oldSession = this.session;
      this.session = null;
      if (oldSession) {
        try {
          oldSession.dispose();
        } catch (disposeErr) {
          // dispose() should not throw — log and continue so the rotation still happens.
          log.warn('[AgentHost] Error disposing old session during reset:', disposeErr);
        }
      }

      const newFilename = writeRotatedFile(sessionDir, activeFile, [
        createSessionHeader(SYSTEM2_DIR),
      ]);
      // Cap archive count: this path runs once per scheduled task on opted-in roles (Narrator
      // produces ~48 archives/day on a 30-min cron), so unbounded retention drives steady disk
      // pressure. Prune to the configured cap so storage stays bounded regardless of runtime.
      pruneArchives(sessionDir, this.archiveKeepCount);
      // Reset compaction state alongside the session: the new JSONL has no prior compactions,
      // so leaving the counter at its prior value (observed at 241+ during the cascade this
      // feature fixes) would let the pruning trigger fire spuriously against the empty file.
      // Persist 0 to disk too, since initialize() rehydrates compactionCount from the
      // .compaction-count file.
      this.compactionCount = 0;
      this.writeCompactionCount(0);
      // Clear lastTurnErrored: a leftover error flag from the just-completed scheduled task
      // would otherwise corrupt cleanup decisions on the first agent_end of the fresh session.
      this.lastTurnErrored = false;
      log.info(
        `[AgentHost] Reset ${this.agentRole ?? 'agent'} session after scheduled task; JSONL truncated to fresh header (${newFilename}).`
      );
    } catch (err) {
      log.error('[AgentHost] Failed to reset session JSONL after scheduled task:', err);
    }
  }

  /**
   * Reclaim a reset-opted role's session if a prior scheduled-task cycle left it oversized, so the
   * next cycle starts from a fresh header. The per-tick `resetSessionToHeader` is gated on a clean
   * `agent_end`, which a wedged turn (issue #194) or a context-overflow recovery loop bypasses —
   * letting the JSONL accumulate one payload per cron tick until it overflows the context window.
   * Called by the scheduler before delivering. The Narrator's durable memory lives in files, so
   * dropping session state is safe. No-op for non-opted-in roles or a still-small session. Returns
   * true if it reclaimed.
   */
  async reclaimBloatedSession(): Promise<boolean> {
    if (!this.resetSessionAfterScheduledTask) return false;
    // Reclaim only between turns: skip while a delivery (deliverySendCount) or user prompt
    // (pendingPrompt) is in flight, or during reinit. A wedged delivery's dispatch timeout clears
    // deliverySendCount, so a stuck session becomes reclaimable on a later cycle.
    if (this.isReinitializing || this.deliverySendCount > 0 || this.pendingPrompt) return false;
    const sessionDir = this._sessionDir;
    if (!sessionDir) return false;
    const activeFile = findMostRecentSession(sessionDir);
    if (!activeFile) return false;
    let sizeBytes: number;
    try {
      sizeBytes = statSync(activeFile).size;
    } catch {
      return false;
    }
    if (sizeBytes < this.scheduledTaskSessionReclaimBytes) return false;

    log.warn(
      `[AgentHost] ${this.agentRole ?? 'agent'} session is ${(sizeBytes / 1024 / 1024).toFixed(2)} MB at ` +
        `scheduled-task cycle start; a prior cycle left it un-reset (wedged turn or context-overflow loop). ` +
        `Reclaiming to a fresh header.`
    );

    if (this.busy) {
      this.busy = false;
      this.onBusyChange?.(this.agentId, false, this.getContextUsage()?.percent ?? null);
    }

    // Mirror the agent_end reset path. Set isReinitializing before tearing the session down so a
    // concurrent deliverMessage() queues (it checks isReinitializing) instead of dispatching against
    // the disposed session or hard-rejecting on session=null. After initialize() resolves, replay any
    // queued deliveries against the fresh session so none are stranded; on init failure, reject them
    // so awaiting callers (e.g. trackJobExecution) don't hang.
    this.isReinitializing = true;
    this.resetSessionToHeader();
    try {
      await this.initialize();
      this.replayPendingDeliveries('after oversized-session reclaim');
    } catch (err) {
      const rejectError = err instanceof Error ? err : new Error(String(err));
      for (const delivery of this.pendingDeliveries) {
        delivery.reject(rejectError);
      }
      this.pendingDeliveries = [];
      this.deliverySendCount = 0;
      throw rejectError;
    } finally {
      this.isReinitializing = false;
    }
    return true;
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
      // Reset the counter so we don't re-attempt baseline lookup on every
      // subsequent agent_end. The next pruning attempt fires after another
      // `compactionDepth` regular compactions accumulate; by then a baseline
      // is much more likely to exist.
      log.info('[AgentHost] No baseline found for pruning, resetting counter and skipping');
      this.compactionCount = 0;
      this.writeCompactionCount(0);
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
    log.info(`[AgentHost] Pruning compaction completed for agent ${this.agentId}`);
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
   * Proactive context check before failover: if the current context exceeds the
   * candidate provider's model context window, compact first so the failover can succeed.
   */
  private async compactForProvider(provider: LlmProvider): Promise<void> {
    const candidateModelId = this.agentModels[provider];
    if (!candidateModelId) return;

    const candidateModel = this.modelRegistry.find(provider, candidateModelId);
    if (!candidateModel) return;

    const currentUsage = this.getContextUsage();
    if (currentUsage?.tokens == null) return;

    if (currentUsage.tokens > candidateModel.contextWindow) {
      log.info(
        `[AgentHost] Context (${currentUsage.tokens} tokens) exceeds ${provider}/${candidateModelId} ` +
          `window (${candidateModel.contextWindow}), compacting before failover`
      );
      // Use the target provider for compaction since the current provider may be broken
      // (e.g., invalid API key, no credits). The truncated context fits within the target
      // model's window (split at 50%), so the compact() call will succeed.
      await this.handleContextOverflow(candidateModel.contextWindow, provider);
    }
  }

  /**
   * Reset state and replay pending deliveries after context overflow recovery.
   * Called after handleContextOverflow() returns true (session successfully recovered).
   * Callers must return immediately after this — the session is live again.
   */
  private replayAfterContextOverflow(): void {
    // Clear the overflow-causing prompt so a future failover doesn't retry it
    this.pendingPrompt = null;
    this.deliverySendCount = 0;
    this.replayPendingDeliveries('after context overflow');
  }

  /**
   * Dispatch pending deliveries against the current session via sendCustomMessage.
   *
   * Walks `pendingDeliveries` from `deliverySendCount` onward (i.e., skipping already-sent
   * items at the head of the queue). Sends each via the SDK with `followUp` semantics,
   * respecting the scheduled-task gate: a scheduled-task delivery is NOT sent while any
   * other delivery is in flight, and only one scheduled-task delivery is sent per call.
   *
   * Why the gate: the Pi SDK treats `sendCustomMessage(followUp)` on a busy session as a
   * follow-up turn in the current run, so without this gate multiple scheduled-task
   * deliveries pile up as follow-ups within one run. Each delivery's API call then carries
   * the prior turns as conversation history. With a ~512 KB per-delivery activity budget
   * (catch_up_budget_bytes) and 3 deliveries per daily-summary tick, by the 3rd delivery
   * the request blows the model's 1M-token context window. Serializing scheduled tasks one
   * per run lets the post-scheduled-task session reset (host.ts:763) fire between them, so
   * each delivery starts on a fresh, lean session. See GitHub issue #189.
   *
   * Called from three places: (1) `deliverMessage` after pushing a new delivery, (2)
   * `agent_end` handler after delivery-cleanup, and (3) the reset path's `initialize().then`
   * after a fresh session is ready. Recovery callers (context overflow) are responsible
   * for clearing `pendingPrompt` / `deliverySendCount` first. Don't clear
   * `pendingDeliveries` here — `agent_end` shifts each one as turns succeed.
   */
  private clearDeliveryTimers(entry: (typeof this.pendingDeliveries)[number]): void {
    if (entry.deferTimerHandle) {
      clearTimeout(entry.deferTimerHandle);
      entry.deferTimerHandle = undefined;
    }
    if (entry.dispatchTimerHandle) {
      clearTimeout(entry.dispatchTimerHandle);
      entry.dispatchTimerHandle = undefined;
    }
  }

  private armDeferTimer(entry: (typeof this.pendingDeliveries)[number]): void {
    if (entry.deferTimerHandle) clearTimeout(entry.deferTimerHandle);
    const handle = setTimeout(() => {
      this.handleDeferTimeout(entry);
    }, PENDING_DELIVERY_TIMEOUT_MS);
    // unref so an armed watchdog never blocks process shutdown — matches the pattern
    // used by ReminderManager (src/server/reminders/manager.ts).
    handle.unref?.();
    entry.deferTimerHandle = handle;
  }

  private armDispatchTimer(
    entry: (typeof this.pendingDeliveries)[number],
    session: AgentSession
  ): void {
    if (entry.dispatchTimerHandle) clearTimeout(entry.dispatchTimerHandle);
    const handle = setTimeout(() => {
      this.handleDispatchTimeout(entry, session);
    }, DELIVERY_DISPATCH_TIMEOUT_MS);
    handle.unref?.();
    entry.dispatchTimerHandle = handle;
  }

  private handleDeferTimeout(entry: (typeof this.pendingDeliveries)[number]): void {
    const idx = this.pendingDeliveries.indexOf(entry);
    if (idx === -1) return;
    // Race-window guard: if replayPendingDeliveries dispatched the entry between the
    // timer firing and this callback running, the deferred flag is already cleared
    // and stealing the entry now would break the in-flight queue invariants.
    if (!entry.deferred) return;
    this.pendingDeliveries.splice(idx, 1);
    log.error(
      `[AgentHost] Delivery wedged in pendingDeliveries for ${
        PENDING_DELIVERY_TIMEOUT_MS / 1000
      }s; rejecting (session never recovered)`
    );
    entry.reject(
      new Error(
        `Delivery never reached SDK after ${
          PENDING_DELIVERY_TIMEOUT_MS / 1000
        }s; session appears wedged`
      )
    );
  }

  private handleDispatchTimeout(
    entry: (typeof this.pendingDeliveries)[number],
    session: AgentSession
  ): void {
    // Failover swapped the session — counters belong to the new session now.
    if (this.session !== session) return;
    const idx = this.pendingDeliveries.indexOf(entry);
    if (idx === -1) return;
    this.pendingDeliveries.splice(idx, 1);
    this.deliverySendCount = Math.max(0, this.deliverySendCount - 1);
    // A stalled partial-stream turn would otherwise leave currentTurnHasOutput=true
    // and mis-classify the next dispatch as contaminated in handlePotentialError.
    this.currentTurnHasOutput = false;
    // Message is intentionally general: the timer is armed across the full window from
    // when we commit to dispatching (deliverySendCount++) through agent_end. A timeout
    // here means no agent_end ever fired, but the root cause could be a hung
    // pre-send step (resourceLoader.reload) as well as a lost SDK stream. Keeping the
    // timer armed across the whole window is the safer choice (no unguarded window);
    // the broader message accurately covers both possibilities.
    log.error(
      `[AgentHost] Delivery did not produce agent_end within ${
        DELIVERY_DISPATCH_TIMEOUT_MS / 1000
      }s; rejecting`
    );
    entry.reject(
      new Error(
        `Delivery did not complete within ${
          DELIVERY_DISPATCH_TIMEOUT_MS / 1000
        }s (no agent_end received; SDK stream may be lost or a pre-send step stalled)`
      )
    );
    // The wedged turn is dead and no agent_end will fire, so clear `busy` here (its normal owner).
    // Otherwise the agent appears busy forever; a late agent_end finds busy already false and no-ops.
    if (this.busy) {
      this.busy = false;
      this.onBusyChange?.(this.agentId, false, this.getContextUsage()?.percent ?? null);
    }
    if (!this.isReinitializing && this.pendingDeliveries.some((d) => d.deferred)) {
      this.replayPendingDeliveries('after dispatch timeout');
    }
  }

  private replayPendingDeliveries(context: string): void {
    // session=null is the right guard: resetSessionToHeader nulls session synchronously, so
    // agent_end's call here returns early when reset just fired. The reset path's
    // initialize().then(...) installs a fresh session before calling this helper, at which
    // point isReinitializing may still be true (cleared in .finally) but session is live —
    // we must not bail then, or the deferred deliveries would never get sent.
    if (!this.session) return;
    while (this.deliverySendCount < this.pendingDeliveries.length) {
      const delivery = this.pendingDeliveries[this.deliverySendCount];
      // Scheduled-task gate: don't pile a scheduled-task delivery onto an in-flight delivery.
      // The next dispatch (triggered by agent_end after the in-flight delivery's turn ends)
      // will send this one.
      if (delivery.scheduledTask && this.deliverySendCount > 0) break;
      this.deliverySendCount++;
      // Clear deferred flag now that the item is being sent — agent_end's gate uses this
      // to decide whether to call this helper, and we don't want to re-dispatch.
      delivery.deferred = false;
      const session = this.session;
      if (delivery.deferTimerHandle) {
        clearTimeout(delivery.deferTimerHandle);
        delivery.deferTimerHandle = undefined;
      }
      this.armDispatchTimer(delivery, session);
      // Wrap in Promise.resolve so synchronous returns from sendCustomMessage (some test
      // doubles return undefined directly) don't blow up the .catch chain.
      Promise.resolve(
        session.sendCustomMessage(
          {
            customType: 'agent_message',
            content: delivery.content,
            display: false,
            details: delivery.details,
          },
          {
            deliverAs: delivery.urgent ? 'steer' : 'followUp',
            triggerTurn: true,
          }
        )
      ).catch((error) => {
        // If session changed mid-flight (failover/reinit), this catch belongs to a stale
        // send; the new session has its own dispatch path. Mutating state here would
        // corrupt the live session's counters.
        if (this.session !== session) return;
        this.deliverySendCount = Math.max(0, this.deliverySendCount - 1);
        log.error(`[AgentHost] Failed to dispatch delivery ${context}:`, error);
        const idx = this.pendingDeliveries.indexOf(delivery);
        if (idx !== -1) this.pendingDeliveries.splice(idx, 1);
        delivery.reject(error instanceof Error ? error : new Error(String(error)));
        // Release the scheduled-task gate: agent_end won't fire for a send that never reached
        // the agent. Without re-dispatch, deferred deliveries behind the failed send would sit
        // in the queue forever. Copilot review #2 raised this on PR #191.
        if (this.pendingDeliveries.some((d) => d.deferred)) {
          this.replayPendingDeliveries('after dispatch failure');
        }
      });
      // Scheduled-task gate (after-send half): only one scheduled-task delivery per dispatch.
      // After this delivery's agent_end fires, the next dispatch will pick up where we left off.
      if (delivery.scheduledTask) break;
    }
  }

  /**
   * Emergency recovery for context overflow errors.
   *
   * When the context window is exceeded and no API call can succeed, this method:
   * 1. Splits the active JSONL at a safe threshold (50% of the effective context window)
   * 2. Truncates the file to that safe point, reinitializes, and compacts
   * 3. Appends the tail (post-split entries) back and reinitializes again
   *
   * The result is a session with a compact summary of the safe history plus the
   * recent tail, consuming a fraction of the context window.
   */
  private async handleContextOverflow(
    targetContextWindow?: number,
    compactionProvider?: LlmProvider
  ): Promise<boolean> {
    const sessionDir = this.sessionDir;
    if (!this.session || !sessionDir) {
      log.info('[AgentHost] Context overflow: no session or sessionDir, cannot recover');
      return false;
    }

    log.info('[AgentHost] Starting context overflow recovery...');

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
        log.info('[AgentHost] Context overflow: no JSONL files found');
        return false;
      }

      activeFile = jsonlFiles[0].path;
      const lines = readFileSync(activeFile, 'utf-8')
        .split('\n')
        .filter((l) => l.trim());

      // Step 2: Find last message entry below the split threshold.
      // Split at 50% of the effective context window, matching the SDK's reserveTokens
      // auto-compaction setting and leaving headroom for system prompt, knowledge files,
      // and compaction overhead.
      const effectiveWindow = targetContextWindow ?? this.contextWindow;
      const threshold = effectiveWindow * 0.5;
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
        log.info('[AgentHost] Context overflow: no safe split point found');
        return false;
      }

      // Step 3: Split into head and tail
      const headLines = lines.slice(0, splitIndex + 1);
      tailLines = lines.slice(splitIndex + 1);
      log.info(
        `[AgentHost] Context overflow: split at line ${splitIndex + 1}, tail has ${tailLines.length} entries`
      );

      // Bound the tail by bytes. The split above keys off message-level `usage.input`, which
      // injected `custom_message` deliveries don't carry — so a tail packed with oversized
      // deliveries can stay over the window and re-overflow on every recovery (the loop that
      // grew the Narrator session to tens of MB). When over budget, drop the tail from the
      // recovered session and continue from the compacted head alone. `tailLines` is left intact
      // (not zeroed) so the catch block can still restore the file if a later step throws; only
      // the success-path append in Step 7 is skipped via `dropOversizedTail`.
      const tailByteBudget = Math.floor(threshold * OVERFLOW_TAIL_BYTES_PER_TOKEN);
      const tailBytes = tailLines.reduce((sum, l) => sum + Buffer.byteLength(l, 'utf8') + 1, 0);
      const dropOversizedTail = tailLines.length > 0 && tailBytes > tailByteBudget;
      if (dropOversizedTail) {
        log.warn(
          `[AgentHost] Context overflow: tail is ${(tailBytes / 1024 / 1024).toFixed(2)} MB (> ` +
            `${(tailByteBudget / 1024 / 1024).toFixed(2)} MB budget) — likely oversized injected deliveries; ` +
            `dropping the tail and recovering from the compacted head alone.`
        );
      }

      // Step 4: Truncate file to head
      writeFileSync(activeFile, `${headLines.join('\n')}\n`, 'utf-8');
      fileTruncated = true;

      // Use the compaction provider if specified (cross-provider failover where
      // the current provider is broken), otherwise use the current provider.
      const provider = compactionProvider ?? this.currentProvider;

      // Step 5: Reinitialize from truncated file
      await this.reinitializeWithProvider(provider, null);

      // Step 6: Compact to reduce head context to ~5%
      if (this.session) {
        log.info('[AgentHost] Context overflow: compacting...');
        await this.session.compact();
        // session.compact() throws on failure, so reaching here means success.
        // Bump the pruning counter directly instead of synthesizing a fake
        // SDK event — handleCompactionTracking is strictly typed against the
        // SDK's AgentSessionEvent union now.
        if (this.compactionDepth > 0) {
          this.bumpCompactionCount();
        }
        log.info('[AgentHost] Context overflow: compaction complete');
      }

      // Step 7: Append tail and reinitialize — session loads compact summary + tail. Skipped when
      // the tail was over budget (dropOversizedTail): recover from the compacted head alone.
      if (tailLines.length > 0 && !dropOversizedTail) {
        appendFileSync(activeFile, `${tailLines.join('\n')}\n`, 'utf-8');
        tailAppended = true;
        log.info('[AgentHost] Context overflow: tail restored, reinitializing...');
        await this.reinitializeWithProvider(provider, null);
      }

      log.info('[AgentHost] Context overflow recovery complete');
      // Re-arm guard so future overflows on this session can recover again
      this.contextOverflowHandled = false;
      return true;
    } catch (error) {
      log.error('[AgentHost] Context overflow recovery failed:', error);
      // Best-effort: if the file was truncated but the tail was not yet appended,
      // restore the tail so no history is permanently lost. Skip if tail was
      // already written to avoid duplicating entries.
      if (fileTruncated && !tailAppended && tailLines.length > 0 && activeFile) {
        try {
          appendFileSync(activeFile, `${tailLines.join('\n')}\n`, 'utf-8');
          log.info('[AgentHost] Context overflow: tail restored after recovery failure');
        } catch {
          // Ignore — best-effort only
        }
      }
      return false;
    }
  }
}
