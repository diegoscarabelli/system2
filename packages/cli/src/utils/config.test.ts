import { describe, expect, it } from 'vitest';
import { buildConfigToml } from './config.js';

describe('buildConfigToml', () => {
  it('generates valid TOML with LLM config', () => {
    const result = buildConfigToml({
      llm: {
        primary: 'anthropic',
        fallback: ['openai'],
        providers: {
          anthropic: {
            keys: [{ key: 'sk-ant-123', label: 'main' }],
          },
        },
      },
    });
    expect(result).toContain('[llm]');
    expect(result).toContain('primary = "anthropic"');
    expect(result).toContain('fallback = ["openai"]');
    expect(result).toContain('[llm.anthropic]');
    expect(result).toContain('sk-ant-123');
  });

  it('includes services section when brave_search configured', () => {
    const result = buildConfigToml({
      services: { brave_search: { key: 'brave-key-123' } },
    });
    expect(result).toContain('[services.brave_search]');
    expect(result).toContain('brave-key-123');
  });

  it('includes tools section when web_search configured', () => {
    const result = buildConfigToml({
      tools: { web_search: { enabled: true, max_results: 10 } },
    });
    expect(result).toContain('[tools.web_search]');
    expect(result).toContain('enabled = true');
    expect(result).toContain('max_results = 10');
  });

  it('uses default operational values when not specified', () => {
    const result = buildConfigToml({});
    expect(result).toContain('cooldown_hours = 24');
    expect(result).toContain('max_backups = 3');
    expect(result).toContain('rotation_threshold_mb = 10');
    expect(result).toContain('max_archives = 5');
    expect(result).toContain('daily_summary_interval_minutes = 30');
    expect(result).toContain('max_history_messages = 100');
  });

  it('uses custom operational values when specified', () => {
    const result = buildConfigToml({
      backup: { cooldownHours: 12, maxBackups: 3 },
      session: { rotationThresholdMB: 20 },
      logs: { rotationThresholdMB: 5, maxArchives: 10 },
      scheduler: { dailySummaryIntervalMinutes: 15 },
      chat: { maxHistoryMessages: 50 },
    });
    expect(result).toContain('cooldown_hours = 12');
    expect(result).toContain('max_backups = 3');
    expect(result).toContain('rotation_threshold_mb = 20');
    expect(result).toContain('rotation_threshold_mb = 5');
    expect(result).toContain('max_archives = 10');
    expect(result).toContain('daily_summary_interval_minutes = 15');
    expect(result).toContain('max_history_messages = 50');
  });

  it('skips empty provider keys', () => {
    const result = buildConfigToml({
      llm: {
        primary: 'anthropic',
        fallback: [],
        providers: {
          anthropic: {
            keys: [
              { key: '', label: 'empty' },
              { key: 'sk-real', label: 'real' },
            ],
          },
        },
      },
    });
    expect(result).not.toContain('empty');
    expect(result).toContain('sk-real');
  });

  it('generates TOML with new providers (mistral, openrouter, xai, groq, cerebras)', () => {
    const result = buildConfigToml({
      llm: {
        primary: 'mistral',
        fallback: ['openrouter', 'groq'],
        providers: {
          mistral: { keys: [{ key: 'mist-key', label: 'default' }] },
          openrouter: { keys: [{ key: 'sk-or-key', label: 'default' }] },
          groq: { keys: [{ key: 'gsk-key', label: 'default' }] },
        },
      },
    });
    expect(result).toContain('primary = "mistral"');
    expect(result).toContain('fallback = ["openrouter", "groq"]');
    expect(result).toContain('[llm.mistral]');
    expect(result).toContain('mist-key');
    expect(result).toContain('[llm.openrouter]');
    expect(result).toContain('sk-or-key');
    expect(result).toContain('[llm.groq]');
    expect(result).toContain('gsk-key');
  });

  it('generates TOML with openai-compatible provider including base_url and model', () => {
    const result = buildConfigToml({
      llm: {
        primary: 'openai-compatible',
        fallback: [],
        providers: {
          'openai-compatible': {
            keys: [{ key: 'proxy-key', label: 'local' }],
            base_url: 'http://localhost:4000/v1',
            model: 'my-model',
          },
        },
      },
    });
    expect(result).toContain('primary = "openai-compatible"');
    expect(result).toContain('[llm.openai-compatible]');
    expect(result).toContain('proxy-key');
    expect(result).toContain('base_url = "http://localhost:4000/v1"');
    expect(result).toContain('model = "my-model"');
  });

  it('includes compat_reasoning field for openai-compatible provider', () => {
    const result = buildConfigToml({
      llm: {
        primary: 'openai-compatible',
        fallback: [],
        providers: {
          'openai-compatible': {
            keys: [{ key: 'proxy-key', label: 'local' }],
            base_url: 'http://localhost:4000/v1',
            model: 'my-model',
            compat_reasoning: true,
          },
        },
      },
    });
    expect(result).toContain('compat_reasoning = true');
  });

  it('emits compat_reasoning = false when explicitly set', () => {
    const result = buildConfigToml({
      llm: {
        primary: 'openai-compatible',
        fallback: [],
        providers: {
          'openai-compatible': {
            keys: [{ key: 'proxy-key', label: 'local' }],
            base_url: 'http://localhost:4000/v1',
            model: 'my-model',
            compat_reasoning: false,
          },
        },
      },
    });
    expect(result).toContain('compat_reasoning = false');
  });

  it('omits compat_reasoning when undefined for openai-compatible', () => {
    const result = buildConfigToml({
      llm: {
        primary: 'openai-compatible',
        fallback: [],
        providers: {
          'openai-compatible': {
            keys: [{ key: 'proxy-key', label: 'local' }],
            base_url: 'http://localhost:4000/v1',
            model: 'my-model',
          },
        },
      },
    });
    expect(result).not.toContain('compat_reasoning');
  });

  it('omits base_url and model for non openai-compatible providers', () => {
    const result = buildConfigToml({
      llm: {
        primary: 'xai',
        fallback: [],
        providers: {
          xai: { keys: [{ key: 'xai-key', label: 'default' }] },
        },
      },
    });
    expect(result).toContain('[llm.xai]');
    expect(result).toContain('xai-key');
    expect(result).not.toContain('base_url');
    expect(result).not.toContain('model =');
  });

  it('includes databases section when configured', () => {
    const result = buildConfigToml({
      databases: {
        analytics: {
          type: 'postgres',
          database: 'analytics',
          host: 'db.example.com',
          port: 5432,
          user: 'readonly',
          query_timeout: 60,
          max_rows: 50000,
        },
      },
    });
    expect(result).toContain('[databases.analytics]');
    expect(result).toContain('type = "postgres"');
    expect(result).toContain('database = "analytics"');
    expect(result).toContain('host = "db.example.com"');
    expect(result).toContain('port = 5432');
    expect(result).toContain('user = "readonly"');
    expect(result).toContain('query_timeout = 60');
    expect(result).toContain('max_rows = 50000');
  });

  it('omits databases section when not configured', () => {
    const result = buildConfigToml({});
    expect(result).not.toContain('[databases.');
  });
});
