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
import type {
  DatabaseConnectionConfig,
  DatabasesConfig,
  LlmConfig,
  LlmProvider,
  LlmProviderConfig,
  ServicesConfig,
  ToolsConfig,
} from '@dscarabelli/shared';
import TOML from '@iarna/toml';

export const SYSTEM2_DIR = join(homedir(), '.system2');
export const CONFIG_FILE = join(SYSTEM2_DIR, 'config.toml');

/**
 * Configuration schema with all available settings.
 */
export interface System2Config {
  llm?: LlmConfig;
  services?: ServicesConfig;
  tools?: ToolsConfig;
  databases?: DatabasesConfig;
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
    openrouter?: { keys?: Array<{ key: string; label: string }> };
    xai?: { keys?: Array<{ key: string; label: string }> };
    'openai-compatible'?: {
      keys?: Array<{ key: string; label: string }>;
      base_url?: string;
      model?: string;
      compat_reasoning?: boolean;
    };
  };
  services?: {
    brave_search?: { key?: string };
  };
  tools?: {
    web_search?: { enabled?: boolean; max_results?: number };
  };
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
    }
  >;
}

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
function convertTomlLlm(toml: NonNullable<TomlConfig['llm']>): LlmConfig {
  const providers: Partial<Record<LlmProvider, LlmProviderConfig>> = {};

  for (const name of [
    'anthropic',
    'cerebras',
    'google',
    'groq',
    'mistral',
    'openai',
    'openrouter',
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

  return {
    primary: (toml.primary as LlmProvider) ?? 'anthropic',
    fallback: (toml.fallback as LlmProvider[]) ?? [],
    providers,
  };
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
 * Convert TOML databases section to DatabasesConfig.
 * Entries missing required fields (type, database) are skipped with a warning.
 */
function convertTomlDatabases(toml: NonNullable<TomlConfig['databases']>): DatabasesConfig {
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

    databases[name] = conn;
  }

  return databases;
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

    if (tomlConfig.services) {
      config.services = convertTomlServices(tomlConfig.services);
    }

    if (tomlConfig.tools) {
      config.tools = convertTomlTools(tomlConfig.tools);
    }

    if (tomlConfig.databases) {
      config.databases = convertTomlDatabases(tomlConfig.databases);
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
  services?: ServicesConfig;
  tools?: ToolsConfig;
  databases?: DatabasesConfig;
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
  if (options.databases) {
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
      lines.push('');
    }
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

  return lines.join('\n');
}

/**
 * Write config.toml with secure permissions (0600).
 */
export function writeConfigFile(content: string): void {
  writeFileSync(CONFIG_FILE, content, { mode: 0o600 });
}
