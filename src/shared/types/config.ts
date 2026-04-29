/**
 * Configuration Types
 *
 * Shared type definitions for System2 configuration (config.toml).
 * Used by both CLI (config loading) and server (AuthResolver, AgentHost).
 */

export type LlmProvider =
  | 'anthropic'
  | 'cerebras'
  | 'google'
  | 'groq'
  | 'mistral'
  | 'openai'
  | 'openai-compatible'
  | 'openrouter'
  | 'xai';

export interface LlmKey {
  key: string;
  label: string;
}

export interface LlmProviderConfig {
  keys: LlmKey[];
  base_url?: string;
  model?: string;
  compat_reasoning?: boolean;
  routing?: Record<string, string[]>;
}

export interface LlmOAuthConfig {
  primary: LlmProvider;
  fallback: LlmProvider[];
}

export interface LlmConfig {
  primary: LlmProvider;
  fallback: LlmProvider[];
  providers: Partial<Record<LlmProvider, LlmProviderConfig>>;
  /** Optional OAuth tier. When present, OAuth credentials are tried before API keys. */
  oauth?: LlmOAuthConfig;
}

export interface BraveSearchConfig {
  key: string;
}

export interface ServicesConfig {
  brave_search?: BraveSearchConfig;
}

export interface WebSearchToolConfig {
  enabled: boolean;
  max_results: number;
}

export interface ToolsConfig {
  web_search?: WebSearchToolConfig;
}

export interface SchedulerConfig {
  daily_summary_interval_minutes: number;
}

export interface ChatConfig {
  max_history_messages: number;
}

export interface KnowledgeConfig {
  budget_chars: number;
}

export interface DatabaseConnectionConfig {
  type: string;
  host?: string;
  port?: number;
  database: string;
  user?: string;
  password?: string;
  socket?: string;
  ssl?: boolean;
  query_timeout?: number;
  max_rows?: number;
  account?: string;
  warehouse?: string;
  role?: string;
  schema?: string;
  project?: string;
  credentials_file?: string;
}

export interface DatabasesConfig {
  [name: string]: DatabaseConnectionConfig;
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high';

export interface AgentOverrideConfig {
  thinking_level?: ThinkingLevel;
  compaction_depth?: number;
  models?: Partial<Record<Exclude<LlmProvider, 'openai-compatible'>, string>>;
}

export interface AgentsConfig {
  [role: string]: AgentOverrideConfig;
}

export interface DeliveryConfig {
  max_bytes: number;
  catch_up_budget_bytes: number;
  narrator_message_excerpt_bytes: number;
}

export interface SessionConfig {
  /** Rotation threshold in bytes. Above this size, the JSONL is rotated. If a compaction anchor
   *  exists, rotation copies forward from `firstKeptEntryId`. Otherwise it falls back to keeping
   *  the session header + a bounded tail (up to ~1 MB) starting at the first user-turn entry in
   *  that tail. If no user turn exists in the kept window — or if a single entry alone exceeds
   *  the tail cap — rotation writes only the new session header. */
  rotation_size_bytes: number;
}

/** Single source of truth for the default session-rotation threshold (10 MB). Both the CLI's
 *  generated config.toml and the server's `rotateSessionIfNeeded` parameter default reference
 *  this constant so they cannot drift. */
export const DEFAULT_SESSION_ROTATION_SIZE_BYTES = 10 * 1024 * 1024;
