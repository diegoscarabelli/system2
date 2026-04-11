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
}

export interface LlmConfig {
  primary: LlmProvider;
  fallback: LlmProvider[];
  providers: Partial<Record<LlmProvider, LlmProviderConfig>>;
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
