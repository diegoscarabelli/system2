/**
 * Configuration Utility
 *
 * Manages all System2 settings stored in ~/.system2/config.toml.
 * This includes LLM provider keys, service credentials, tool settings,
 * and operational settings (backup, session, logs).
 *
 * Falls back to sensible defaults when values aren't specified.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';
import type {
  AgentOverrideConfig,
  AgentsConfig,
  DatabaseConnectionConfig,
  DatabasesConfig,
  DeliveryConfig,
  LlmConfig,
  LlmProvider,
  LlmProviderConfig,
  ServicesConfig,
  ThinkingLevel,
  ToolsConfig,
} from '../../shared/index.js';

export const SYSTEM2_DIR = join(homedir(), '.system2');
export const CONFIG_FILE = join(SYSTEM2_DIR, 'config.toml');

/**
 * Configuration schema with all available settings.
 */
export interface System2Config {
  llm?: LlmConfig;
  agents?: AgentsConfig;
  services?: ServicesConfig;
  tools?: ToolsConfig;
  databases?: DatabasesConfig;
  delivery?: DeliveryConfig;
  backup: {
    /** Hours between automatic backups (default: 24) */
    cooldownHours: number;
    /** Maximum number of automatic backups to keep (default: 5) */
    maxBackups: number;
  };
  session: {
    /** Session file size threshold for rotation in MB (default: 10) */
    rotationThresholdMB: number;
  };
  logs: {
    /** Log file size threshold for rotation in MB (default: 10) */
    rotationThresholdMB: number;
    /** Maximum number of archived log files to keep (default: 5) */
    maxArchives: number;
  };
  scheduler: {
    /** Minutes between daily summary runs (default: 30) */
    dailySummaryIntervalMinutes: number;
  };
  chat: {
    /** Maximum number of chat messages to keep in history (default: 100) */
    maxHistoryMessages: number;
  };
  knowledge: {
    /** Maximum characters per knowledge file before truncation (default: 20000) */
    budgetChars: number;
  };
}

/**
 * TOML config structure (snake_case keys as they appear in the file).
 */
interface TomlConfig {
  llm?: {
    primary?: string;
    fallback?: string[];
    anthropic?: { keys?: Array<{ key: string; label: string }> };
    cerebras?: { keys?: Array<{ key: string; label: string }> };
    google?: { keys?: Array<{ key: string; label: string }> };
    groq?: { keys?: Array<{ key: string; label: string }> };
    mistral?: { keys?: Array<{ key: string; label: string }> };
    openai?: { keys?: Array<{ key: string; label: string }> };
    openrouter?: {
      keys?: Array<{ key: string; label: string }>;
      routing?: Record<string, string[]>;
    };
    xai?: { keys?: Array<{ key: string; label: string }> };
    'openai-compatible'?: {
      keys?: Array<{ key: string; label: string }>;
      base_url?: string;
      model?: string;
      compat_reasoning?: boolean;
    };
    oauth?: {
      primary?: string;
      fallback?: string[];
    };
  };
  agents?: Record<
    string,
    {
      thinking_level?: string;
      compaction_depth?: number;
      models?: Record<string, string>;
    }
  >;
  services?: {
    brave_search?: { key?: string };
  };
  tools?: {
    web_search?: { enabled?: boolean; max_results?: number };
  };
  databases?: Record<
    string,
    {
      type?: string;
      host?: string;
      port?: number;
      database?: string;
      user?: string;
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
  >;
  backup?: {
    cooldown_hours?: number;
    max_backups?: number;
  };
  session?: {
    rotation_threshold_mb?: number;
  };
  logs?: {
    rotation_threshold_mb?: number;
    max_archives?: number;
  };
  scheduler?: {
    daily_summary_interval_minutes?: number;
  };
  chat?: {
    max_history_messages?: number;
  };
  knowledge?: {
    budget_chars?: number;
  };
  delivery?: {
    max_bytes?: number;
    catch_up_budget_bytes?: number;
    narrator_message_excerpt_bytes?: number;
  };
}

/** Default delivery budget values. Must stay in sync with MAX_DELIVERY_BYTES,
 *  CATCH_UP_BUDGET_BYTES, and NARRATOR_MESSAGE_EXCERPT_BYTES in the server package. */
export const DEFAULT_DELIVERY: DeliveryConfig = {
  max_bytes: 1024 * 1024, // 1048576 — hard cap on inter-agent delivery size (~25% of a 1M-token context window)
  catch_up_budget_bytes: 512 * 1024, // 524288 — producer-side budget; half of max_bytes, leaves headroom for headers/DB-changes/SDK overhead
  narrator_message_excerpt_bytes: 16 * 1024, // 16384 — per-message excerpt cap for Narrator-bound deliveries (daily-summary + project story); 16 KB captures most payloads while truncating pathological 1+ MB cases
};

/**
 * Default operational configuration values.
 */
const DEFAULT_OPERATIONAL: Pick<
  System2Config,
  'backup' | 'session' | 'logs' | 'scheduler' | 'chat' | 'knowledge'
> = {
  backup: {
    cooldownHours: 24,
    maxBackups: 3,
  },
  session: {
    rotationThresholdMB: 10,
  },
  logs: {
    rotationThresholdMB: 10,
    maxArchives: 5,
  },
  scheduler: {
    dailySummaryIntervalMinutes: 30,
  },
  chat: {
    maxHistoryMessages: 100,
  },
  knowledge: {
    budgetChars: 20_000,
  },
};

/**
 * Convert TOML LLM section to LlmConfig.
 */
export function convertTomlLlm(toml: NonNullable<TomlConfig['llm']>): LlmConfig {
  const providers: Partial<Record<LlmProvider, LlmProviderConfig>> = {};

  for (const name of [
    'anthropic',
    'cerebras',
    'google',
    'groq',
    'mistral',
    'openai',
    'xai',
  ] as const) {
    const providerToml = toml[name];
    if (providerToml?.keys && providerToml.keys.length > 0) {
      const validKeys = providerToml.keys.filter((k) => k.key);
      if (validKeys.length > 0) {
        providers[name] = { keys: validKeys };
      }
    }
  }

  // openrouter has an extra field (routing)
  const openrouterToml = toml.openrouter;
  if (openrouterToml?.keys && openrouterToml.keys.length > 0) {
    const validKeys = openrouterToml.keys.filter((k) => k.key);
    if (validKeys.length > 0) {
      const config: LlmProviderConfig = { keys: validKeys };
      if (openrouterToml.routing && Object.keys(openrouterToml.routing).length > 0) {
        const validRouting: Record<string, string[]> = {};
        for (const [prefix, order] of Object.entries(openrouterToml.routing)) {
          if (Array.isArray(order) && order.every((s) => typeof s === 'string' && s.length > 0)) {
            validRouting[prefix] = order;
          } else {
            console.warn(
              `[Config] Ignoring invalid routing entry "${prefix}": expected an array of non-empty strings.`
            );
          }
        }
        if (Object.keys(validRouting).length > 0) {
          config.routing = validRouting;
        }
      }
      providers.openrouter = config;
    }
  }

  // openai-compatible has extra fields (base_url, model)
  const compatToml = toml['openai-compatible'];
  if (compatToml?.keys && compatToml.keys.length > 0) {
    const validKeys = compatToml.keys.filter((k) => k.key);
    if (validKeys.length > 0) {
      providers['openai-compatible'] = {
        keys: validKeys,
        base_url: compatToml.base_url,
        model: compatToml.model,
        compat_reasoning: compatToml.compat_reasoning,
      };
    }
  }

  const config: LlmConfig = {
    primary: (toml.primary as LlmProvider) ?? 'anthropic',
    fallback: (toml.fallback as LlmProvider[]) ?? [],
    providers,
  };

  if (toml.oauth?.primary) {
    config.oauth = {
      primary: toml.oauth.primary as LlmProvider,
      fallback: (toml.oauth.fallback as LlmProvider[]) ?? [],
    };
  }

  return config;
}

/**
 * Convert TOML services section to ServicesConfig.
 */
function convertTomlServices(toml: NonNullable<TomlConfig['services']>): ServicesConfig {
  const services: ServicesConfig = {};
  if (toml.brave_search?.key) {
    services.brave_search = { key: toml.brave_search.key };
  }
  return services;
}

/**
 * Convert TOML tools section to ToolsConfig.
 */
function convertTomlTools(toml: NonNullable<TomlConfig['tools']>): ToolsConfig {
  const tools: ToolsConfig = {};
  if (toml.web_search) {
    tools.web_search = {
      enabled: toml.web_search.enabled ?? false,
      max_results: toml.web_search.max_results ?? 5,
    };
  }
  return tools;
}

/**
 * Convert TOML delivery section to DeliveryConfig, applying defaults for missing or invalid keys.
 * Emits a warning and falls back to the default for any non-positive or non-integer value.
 * Also warns if catch_up_budget_bytes >= max_bytes (producer budget should be < transport cap).
 */
export function convertTomlDelivery(toml: NonNullable<TomlConfig['delivery']>): DeliveryConfig {
  function resolveField(key: keyof DeliveryConfig, raw: number | undefined): number {
    const def = DEFAULT_DELIVERY[key];
    if (raw === undefined) return def;
    if (!Number.isInteger(raw) || raw <= 0) {
      console.warn(
        `[Config] Invalid delivery.${key} = ${raw}. Must be a positive integer. Using default (${def}).`
      );
      return def;
    }
    return raw;
  }

  const max_bytes = resolveField('max_bytes', toml.max_bytes);
  let catch_up_budget_bytes = resolveField('catch_up_budget_bytes', toml.catch_up_budget_bytes);
  const narrator_message_excerpt_bytes = resolveField(
    'narrator_message_excerpt_bytes',
    toml.narrator_message_excerpt_bytes
  );

  if (catch_up_budget_bytes >= max_bytes) {
    // Producer budget must stay strictly below the transport cap; otherwise the scheduler
    // builds messages up to catch_up_budget_bytes that deliverMessage rejects at max_bytes,
    // causing recurring job failures. Clamp to max_bytes - 1, but if that's smaller than
    // the default we prefer the default (which is half of max_bytes when both come from
    // DEFAULT_DELIVERY) when it actually fits.
    const original = catch_up_budget_bytes;
    const clamped = Math.max(max_bytes - 1, 1);
    const def = DEFAULT_DELIVERY.catch_up_budget_bytes;
    catch_up_budget_bytes = def < max_bytes ? def : clamped;
    console.warn(
      `[Config] delivery.catch_up_budget_bytes (${original}) >= delivery.max_bytes (${max_bytes}). ` +
        `Producer budget must be less than the transport cap; clamped to ${catch_up_budget_bytes}.`
    );
  }

  return { max_bytes, catch_up_budget_bytes, narrator_message_excerpt_bytes };
}

/**
 * Convert TOML databases section to DatabasesConfig.
 * Entries missing required fields (type, database) are skipped with a warning.
 */
export function convertTomlDatabases(toml: NonNullable<TomlConfig['databases']>): DatabasesConfig {
  const databases: DatabasesConfig = {};

  for (const [name, entry] of Object.entries(toml)) {
    if (!entry.type || !entry.database) {
      console.warn(
        `[Config] Skipping database "${name}": missing required field "type" or "database"`
      );
      continue;
    }

    const conn: DatabaseConnectionConfig = {
      type: entry.type,
      database: entry.database,
    };

    if (entry.host !== undefined) conn.host = entry.host;
    if (entry.port !== undefined) conn.port = entry.port;
    if (entry.user !== undefined) conn.user = entry.user;
    if (entry.socket !== undefined) conn.socket = entry.socket;
    if (entry.ssl !== undefined) conn.ssl = entry.ssl;
    if (entry.query_timeout !== undefined) {
      const t = Number(entry.query_timeout);
      if (Number.isFinite(t) && t > 0) conn.query_timeout = t;
    }
    if (entry.max_rows !== undefined) {
      const m = Number(entry.max_rows);
      if (Number.isFinite(m) && m > 0) conn.max_rows = Math.min(m, 1_000_000);
    }
    if (entry.account !== undefined) conn.account = entry.account;
    if (entry.warehouse !== undefined) conn.warehouse = entry.warehouse;
    if (entry.role !== undefined) conn.role = entry.role;
    if (entry.schema !== undefined) conn.schema = entry.schema;
    if (entry.project !== undefined) conn.project = entry.project;
    if (entry.credentials_file !== undefined) conn.credentials_file = entry.credentials_file;

    databases[name] = conn;
  }

  return databases;
}

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high']);

const VALID_MODEL_PROVIDERS = new Set<string>([
  'anthropic',
  'cerebras',
  'google',
  'groq',
  'mistral',
  'openai',
  'openrouter',
  'xai',
]);

/**
 * Convert TOML agents section to AgentsConfig.
 * Each entry is a role name with optional overrides for thinking_level, compaction_depth, and models.
 */
export function convertTomlAgents(toml: NonNullable<TomlConfig['agents']>): AgentsConfig {
  const agents: AgentsConfig = {};

  for (const [role, entry] of Object.entries(toml)) {
    const override: AgentOverrideConfig = {};

    if (entry.thinking_level !== undefined) {
      if (VALID_THINKING_LEVELS.has(entry.thinking_level as ThinkingLevel)) {
        override.thinking_level = entry.thinking_level as ThinkingLevel;
      } else {
        console.warn(
          `[Config] Ignoring invalid thinking_level "${entry.thinking_level}" for agent "${role}". Valid values: ${[...VALID_THINKING_LEVELS].join(', ')}`
        );
      }
    }

    if (entry.compaction_depth !== undefined) {
      const d = Number(entry.compaction_depth);
      if (Number.isInteger(d) && d >= 0) {
        override.compaction_depth = d;
      } else {
        console.warn(
          `[Config] Ignoring invalid compaction_depth "${entry.compaction_depth}" for agent "${role}". Expected an integer >= 0.`
        );
      }
    }

    if (entry.models && Object.keys(entry.models).length > 0) {
      const validModels: Record<string, string> = {};
      for (const [provider, model] of Object.entries(entry.models as Record<string, unknown>)) {
        if (!VALID_MODEL_PROVIDERS.has(provider)) {
          console.warn(
            `[Config] Ignoring unknown model provider "${provider}" for agent "${role}". Valid providers: ${[...VALID_MODEL_PROVIDERS].join(', ')}`
          );
          continue;
        }
        if (typeof model === 'string' && model.length > 0) {
          validModels[provider] = model;
        } else {
          console.warn(
            `[Config] Ignoring invalid model "${String(model)}" for provider "${provider}" on agent "${role}". Expected a non-empty string.`
          );
        }
      }
      if (Object.keys(validModels).length > 0) {
        override.models = validModels as AgentOverrideConfig['models'];
      }
    }

    if (Object.keys(override).length > 0) {
      agents[role] = override;
    }
  }

  return agents;
}

/**
 * Convert TOML operational sections (snake_case) to camelCase.
 */
function convertTomlOperational(
  toml: TomlConfig
): Partial<
  Pick<System2Config, 'backup' | 'session' | 'logs' | 'scheduler' | 'chat' | 'knowledge'>
> {
  const config: Partial<
    Pick<System2Config, 'backup' | 'session' | 'logs' | 'scheduler' | 'chat' | 'knowledge'>
  > = {};

  if (toml.backup) {
    config.backup = {
      cooldownHours: toml.backup.cooldown_hours ?? DEFAULT_OPERATIONAL.backup.cooldownHours,
      maxBackups: toml.backup.max_backups ?? DEFAULT_OPERATIONAL.backup.maxBackups,
    };
  }

  if (toml.session) {
    config.session = {
      rotationThresholdMB:
        toml.session.rotation_threshold_mb ?? DEFAULT_OPERATIONAL.session.rotationThresholdMB,
    };
  }

  if (toml.logs) {
    config.logs = {
      rotationThresholdMB:
        toml.logs.rotation_threshold_mb ?? DEFAULT_OPERATIONAL.logs.rotationThresholdMB,
      maxArchives: toml.logs.max_archives ?? DEFAULT_OPERATIONAL.logs.maxArchives,
    };
  }

  if (toml.scheduler) {
    config.scheduler = {
      dailySummaryIntervalMinutes:
        toml.scheduler.daily_summary_interval_minutes ??
        DEFAULT_OPERATIONAL.scheduler.dailySummaryIntervalMinutes,
    };
  }

  if (toml.chat) {
    config.chat = {
      maxHistoryMessages:
        toml.chat.max_history_messages ?? DEFAULT_OPERATIONAL.chat.maxHistoryMessages,
    };
  }

  if (toml.knowledge) {
    config.knowledge = {
      budgetChars: toml.knowledge.budget_chars ?? DEFAULT_OPERATIONAL.knowledge.budgetChars,
    };
  }

  return config;
}

/**
 * Deep merge two objects, with source values overriding target.
 */
function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key in source) {
    if (source[key] !== undefined) {
      if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
        result[key] = deepMerge(
          (target[key] || {}) as Record<string, unknown>,
          source[key] as Record<string, unknown>
        ) as T[Extract<keyof T, string>];
      } else {
        result[key] = source[key] as T[Extract<keyof T, string>];
      }
    }
  }

  return result;
}

/**
 * Load configuration from disk, merging with defaults.
 * Missing operational values are filled in from defaults.
 */
export function loadConfig(): System2Config {
  if (!existsSync(CONFIG_FILE)) {
    return { ...DEFAULT_OPERATIONAL };
  }

  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    const tomlConfig = TOML.parse(content) as TomlConfig;

    const config: System2Config = deepMerge(
      { ...DEFAULT_OPERATIONAL },
      convertTomlOperational(tomlConfig)
    );

    if (tomlConfig.llm) {
      config.llm = convertTomlLlm(tomlConfig.llm);
    }

    if (tomlConfig.agents) {
      config.agents = convertTomlAgents(tomlConfig.agents);
    }

    if (tomlConfig.services) {
      config.services = convertTomlServices(tomlConfig.services);
    }

    if (tomlConfig.tools) {
      config.tools = convertTomlTools(tomlConfig.tools);
    }

    if (tomlConfig.databases) {
      config.databases = convertTomlDatabases(tomlConfig.databases);
    }

    if (tomlConfig.delivery) {
      config.delivery = convertTomlDelivery(tomlConfig.delivery);
    }

    return config;
  } catch (_error) {
    console.warn('[Config] Failed to parse config.toml, using defaults');
    return { ...DEFAULT_OPERATIONAL };
  }
}

/**
 * Build a human-readable config.toml string with comments.
 */
export function buildConfigToml(options: {
  llm?: LlmConfig;
  agents?: AgentsConfig;
  services?: ServicesConfig;
  tools?: ToolsConfig;
  databases?: DatabasesConfig;
  delivery?: DeliveryConfig;
  backup?: System2Config['backup'];
  session?: System2Config['session'];
  logs?: System2Config['logs'];
  scheduler?: System2Config['scheduler'];
  chat?: System2Config['chat'];
  knowledge?: System2Config['knowledge'];
}): string {
  const lines: string[] = [
    '# System2 Configuration',
    '# This file contains all System2 settings including API keys.',
    '# Permissions: 0600 (owner read/write only).',
    '',
  ];

  // LLM section
  if (options.llm) {
    const { primary, fallback, providers } = options.llm;
    lines.push('[llm]');
    lines.push(`primary = "${primary}"`);
    lines.push(`fallback = [${fallback.map((f) => `"${f}"`).join(', ')}]`);
    lines.push('');

    if (options.llm.oauth) {
      lines.push('[llm.oauth]');
      lines.push(`primary = "${options.llm.oauth.primary}"`);
      const fb = options.llm.oauth.fallback.map((f) => `"${f}"`).join(', ');
      lines.push(`fallback = [${fb}]`);
      lines.push('');
    }

    for (const name of [
      'anthropic',
      'cerebras',
      'google',
      'groq',
      'mistral',
      'openai',
      'openai-compatible',
      'openrouter',
      'xai',
    ] as const) {
      const provider = providers[name];
      if (provider && provider.keys.length > 0) {
        lines.push(`[llm.${name}]`);
        lines.push('keys = [');
        for (const key of provider.keys) {
          if (key.key) {
            lines.push(`  { key = "${key.key}", label = "${key.label}" },`);
          }
        }
        lines.push(']');

        // openrouter has extra fields
        if (name === 'openrouter' && provider.routing) {
          lines.push('');
          lines.push('[llm.openrouter.routing]');
          for (const [prefix, order] of Object.entries(provider.routing)) {
            const key = /^[A-Za-z0-9_-]+$/.test(prefix) ? prefix : `"${prefix}"`;
            lines.push(`${key} = [${order.map((s) => `"${s}"`).join(', ')}]`);
          }
        }

        // openai-compatible has extra fields
        if (name === 'openai-compatible') {
          if (provider.base_url) {
            lines.push(`base_url = "${provider.base_url}"`);
          }
          if (provider.model) {
            lines.push(`model = "${provider.model}"`);
          }
          if (provider.compat_reasoning !== undefined) {
            lines.push(`compat_reasoning = ${provider.compat_reasoning}`);
          }
        }

        lines.push('');
      }
    }
  }

  // Agents section (per-role overrides)
  if (options.agents && Object.keys(options.agents).length > 0) {
    for (const [role, override] of Object.entries(options.agents)) {
      const hasScalarFields =
        override.thinking_level !== undefined || override.compaction_depth !== undefined;
      const hasModels = override.models && Object.keys(override.models).length > 0;

      if (hasScalarFields) {
        lines.push(`[agents.${role}]`);
        if (override.thinking_level !== undefined) {
          lines.push(`thinking_level = "${override.thinking_level}"`);
        }
        if (override.compaction_depth !== undefined) {
          lines.push(`compaction_depth = ${override.compaction_depth}`);
        }
        lines.push('');
      }

      if (hasModels && override.models) {
        lines.push(`[agents.${role}.models]`);
        for (const [provider, model] of Object.entries(override.models)) {
          lines.push(`${provider} = "${model}"`);
        }
        lines.push('');
      }
    }
  } else {
    lines.push('# Per-agent model and behavior overrides. Uncomment and edit to customize.');
    lines.push('# Supported roles: guide, conductor, reviewer, narrator, worker');
    lines.push('#');
    lines.push('# Example 1: override thinking level and pin a specific model');
    lines.push('# [agents.conductor]');
    lines.push('# thinking_level = "high"              # off | minimal | low | medium | high');
    lines.push(
      '# compaction_depth = 8                 # keep N auto-compactions in sliding window'
    );
    lines.push('#');
    lines.push('# [agents.conductor.models]');
    lines.push('# anthropic = "claude-opus-4-6"        # pin a model for a specific provider');
    lines.push('#');
    lines.push(
      '# Example 2: route a role through OpenRouter to a specific upstream (e.g. Vertex AI)'
    );
    lines.push('# [agents.conductor.models]');
    lines.push(
      '# openrouter = "google/gemini-3.1-pro-preview" # model ID as listed on openrouter.ai'
    );
    lines.push('#');
    lines.push('# To control which upstream providers OpenRouter uses for a model prefix:');
    lines.push('# [llm.openrouter.routing]');
    lines.push('# "google/" = ["google-vertex/global", "google-vertex", "google-ai-studio"]');
    lines.push('');
  }

  // Services section
  if (options.services?.brave_search) {
    lines.push('[services.brave_search]');
    lines.push(`key = "${options.services.brave_search.key}"`);
    lines.push('');
  }

  // Tools section
  if (options.tools?.web_search) {
    lines.push('[tools.web_search]');
    lines.push(`enabled = ${options.tools.web_search.enabled}`);
    lines.push(`max_results = ${options.tools.web_search.max_results}`);
    lines.push('');
  }

  // Databases section
  if (options.databases && Object.keys(options.databases).length > 0) {
    for (const [name, conn] of Object.entries(options.databases)) {
      lines.push(`[databases.${name}]`);
      lines.push(`type = "${conn.type}"`);
      lines.push(`database = "${conn.database}"`);
      if (conn.host !== undefined) lines.push(`host = "${conn.host}"`);
      if (conn.port !== undefined) lines.push(`port = ${conn.port}`);
      if (conn.user !== undefined) lines.push(`user = "${conn.user}"`);
      if (conn.socket !== undefined) lines.push(`socket = "${conn.socket}"`);
      if (conn.ssl !== undefined) lines.push(`ssl = ${conn.ssl}`);
      if (conn.query_timeout !== undefined) lines.push(`query_timeout = ${conn.query_timeout}`);
      if (conn.max_rows !== undefined) lines.push(`max_rows = ${conn.max_rows}`);
      if (conn.account !== undefined) lines.push(`account = "${conn.account}"`);
      if (conn.warehouse !== undefined) lines.push(`warehouse = "${conn.warehouse}"`);
      if (conn.role !== undefined) lines.push(`role = "${conn.role}"`);
      if (conn.schema !== undefined) lines.push(`schema = "${conn.schema}"`);
      if (conn.project !== undefined) lines.push(`project = "${conn.project}"`);
      if (conn.credentials_file !== undefined)
        lines.push(`credentials_file = "${conn.credentials_file}"`);
      lines.push('');
    }
  } else {
    lines.push('# External database connections for the query_database tool.');
    lines.push('# Each [databases.<name>] section defines a named connection.');
    lines.push('#');
    lines.push('# [databases.mydb]');
    lines.push(
      '# type = "postgres"              # postgres | mysql | sqlite | mssql | clickhouse | duckdb | snowflake | bigquery'
    );
    lines.push('# host = "localhost"');
    lines.push('# port = 5432');
    lines.push('# database = "mydb"');
    lines.push('# user = "readonly"');
    lines.push('');
  }

  // Operational sections
  const backup = options.backup ?? DEFAULT_OPERATIONAL.backup;
  const session = options.session ?? DEFAULT_OPERATIONAL.session;
  const logs = options.logs ?? DEFAULT_OPERATIONAL.logs;

  lines.push('[backup]');
  lines.push(`# Hours between automatic backups (minimum: 1)`);
  lines.push(`cooldown_hours = ${backup.cooldownHours}`);
  lines.push('');
  lines.push(`# Maximum number of automatic backups to keep`);
  lines.push(`max_backups = ${backup.maxBackups}`);
  lines.push('');
  lines.push('[session]');
  lines.push(`# Session file size threshold for rotation in MB`);
  lines.push(`rotation_threshold_mb = ${session.rotationThresholdMB}`);
  lines.push('');
  lines.push('[logs]');
  lines.push(`# Log file size threshold for rotation in MB`);
  lines.push(`rotation_threshold_mb = ${logs.rotationThresholdMB}`);
  lines.push('');
  lines.push(`# Maximum number of archived log files to keep`);
  lines.push(`max_archives = ${logs.maxArchives}`);
  lines.push('');

  const scheduler = options.scheduler ?? DEFAULT_OPERATIONAL.scheduler;
  lines.push('[scheduler]');
  lines.push(`# Minutes between daily summary runs`);
  lines.push(`daily_summary_interval_minutes = ${scheduler.dailySummaryIntervalMinutes}`);
  lines.push('');

  const chat = options.chat ?? DEFAULT_OPERATIONAL.chat;
  lines.push('[chat]');
  lines.push(`# Maximum number of chat messages to keep in UI history`);
  lines.push(`max_history_messages = ${chat.maxHistoryMessages}`);
  lines.push('');

  const knowledge = options.knowledge ?? DEFAULT_OPERATIONAL.knowledge;
  lines.push('[knowledge]');
  lines.push(`# Maximum characters per knowledge file before truncation`);
  lines.push(`budget_chars = ${knowledge.budgetChars}`);
  lines.push('');

  const delivery = options.delivery ?? DEFAULT_DELIVERY;
  lines.push('[delivery]');
  lines.push(
    `# Hard cap on inter-agent delivery size in bytes (default: ${DEFAULT_DELIVERY.max_bytes})`
  );
  lines.push(`max_bytes = ${delivery.max_bytes}`);
  lines.push('');
  lines.push(
    `# Producer-side budget for catch-up / daily-summary deliveries in bytes (default: ${DEFAULT_DELIVERY.catch_up_budget_bytes})`
  );
  lines.push(`catch_up_budget_bytes = ${delivery.catch_up_budget_bytes}`);
  lines.push('');
  lines.push(
    `# Per-message excerpt cap for Narrator-bound deliveries (daily-summary + project story) in bytes (default: ${DEFAULT_DELIVERY.narrator_message_excerpt_bytes})`
  );
  lines.push(`narrator_message_excerpt_bytes = ${delivery.narrator_message_excerpt_bytes}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Write config.toml with secure permissions (0600).
 */
export function writeConfigFile(content: string): void {
  writeFileSync(CONFIG_FILE, content, { mode: 0o600 });
}
