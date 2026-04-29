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
  /** Regular rotation threshold in bytes. Above this size, rotation reads the JSONL and
   *  copies forward from the latest compaction anchor. */
  rotation_size_bytes: number;
  /** Hard-fallback threshold in bytes. When the file exceeds this AND no compaction anchor
   *  exists (e.g., the agent has been failing to complete turns for long enough that the SDK
   *  never wrote a compaction), rotation force-keeps only the session header + the most recent
   *  tail of entries so cold start can recover. Must be >= `rotation_size_bytes`. */
  hard_fallback_size_bytes: number;
}
