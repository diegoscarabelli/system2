/**
 * Configuration Utility
 *
 * Manages user-configurable settings stored in ~/.system2/config.toml.
 * Falls back to sensible defaults when values aren't specified.
 */

import { existsSync, readFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import TOML from '@iarna/toml';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SYSTEM2_DIR = join(homedir(), '.system2');
const CONFIG_FILE = join(SYSTEM2_DIR, 'config.toml');

/**
 * Configuration schema with all available settings.
 */
export interface System2Config {
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
}

/**
 * TOML config structure (snake_case keys).
 */
interface TomlConfig {
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
}

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: System2Config = {
  backup: {
    cooldownHours: 24,
    maxBackups: 5,
  },
  session: {
    rotationThresholdMB: 10,
  },
  logs: {
    rotationThresholdMB: 10,
    maxArchives: 5,
  },
};

/**
 * Convert TOML config (snake_case) to System2Config (camelCase).
 */
function convertTomlToConfig(toml: TomlConfig): Partial<System2Config> {
  const config: Partial<System2Config> = {};

  if (toml.backup) {
    config.backup = {
      cooldownHours: toml.backup.cooldown_hours ?? DEFAULT_CONFIG.backup.cooldownHours,
      maxBackups: toml.backup.max_backups ?? DEFAULT_CONFIG.backup.maxBackups,
    };
  }

  if (toml.session) {
    config.session = {
      rotationThresholdMB:
        toml.session.rotation_threshold_mb ?? DEFAULT_CONFIG.session.rotationThresholdMB,
    };
  }

  if (toml.logs) {
    config.logs = {
      rotationThresholdMB:
        toml.logs.rotation_threshold_mb ?? DEFAULT_CONFIG.logs.rotationThresholdMB,
      maxArchives: toml.logs.max_archives ?? DEFAULT_CONFIG.logs.maxArchives,
    };
  }

  return config;
}

/**
 * Deep merge two objects, with source values overriding target.
 */
function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key in source) {
    if (source[key] !== undefined) {
      if (
        typeof source[key] === 'object' &&
        source[key] !== null &&
        !Array.isArray(source[key])
      ) {
        result[key] = deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key] as T[Extract<keyof T, string>];
      }
    }
  }

  return result;
}

/**
 * Load configuration from disk, merging with defaults.
 * Missing values are filled in from defaults.
 */
export function loadConfig(): System2Config {
  if (!existsSync(CONFIG_FILE)) {
    return DEFAULT_CONFIG;
  }

  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    const tomlConfig = TOML.parse(content) as TomlConfig;
    const userConfig = convertTomlToConfig(tomlConfig);
    return deepMerge(DEFAULT_CONFIG, userConfig);
  } catch (error) {
    // If parsing fails, return defaults
    console.warn('[Config] Failed to parse config.toml, using defaults');
    return DEFAULT_CONFIG;
  }
}

/**
 * Copy the default config.toml template to ~/.system2/ if one doesn't exist.
 */
export function copyConfigTemplateIfMissing(): void {
  if (existsSync(CONFIG_FILE)) {
    return;
  }

  if (!existsSync(SYSTEM2_DIR)) {
    return; // Don't create config before onboarding
  }

  // Template is in dist/config/config.toml (copied by tsup build)
  const templatePath = join(__dirname, '..', 'config', 'config.toml');

  if (existsSync(templatePath)) {
    copyFileSync(templatePath, CONFIG_FILE);
  }
}
