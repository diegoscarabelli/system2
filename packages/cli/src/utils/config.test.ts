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
});
