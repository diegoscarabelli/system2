import { describe, expect, it, vi } from 'vitest';
import { buildConfigToml, convertTomlDatabases } from './config.js';

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

  it('serializes snowflake-specific fields (account, warehouse, role, schema)', () => {
    const result = buildConfigToml({
      databases: {
        snow: {
          type: 'snowflake',
          database: 'ANALYTICS',
          account: 'xy12345.us-east-1',
          warehouse: 'COMPUTE_WH',
          user: 'analyst',
          role: 'ANALYST',
          schema: 'PUBLIC',
        },
      },
    });
    expect(result).toContain('[databases.snow]');
    expect(result).toContain('type = "snowflake"');
    expect(result).toContain('account = "xy12345.us-east-1"');
    expect(result).toContain('warehouse = "COMPUTE_WH"');
    expect(result).toContain('role = "ANALYST"');
    expect(result).toContain('schema = "PUBLIC"');
  });

  it('serializes bigquery-specific fields (project, credentials_file)', () => {
    const result = buildConfigToml({
      databases: {
        bq: {
          type: 'bigquery',
          database: 'my_dataset',
          project: 'my-project-123',
          credentials_file: '/path/to/sa.json',
        },
      },
    });
    expect(result).toContain('[databases.bq]');
    expect(result).toContain('type = "bigquery"');
    expect(result).toContain('project = "my-project-123"');
    expect(result).toContain('credentials_file = "/path/to/sa.json"');
  });

  it('outputs multiple [databases.*] sections', () => {
    const result = buildConfigToml({
      databases: {
        pg: { type: 'postgres', database: 'mydb', host: 'pg.local', port: 5432, user: 'admin' },
        my: { type: 'mysql', database: 'app', host: 'mysql.local', port: 3306 },
      },
    });
    expect(result).toContain('[databases.pg]');
    expect(result).toContain('type = "postgres"');
    expect(result).toContain('host = "pg.local"');
    expect(result).toContain('[databases.my]');
    expect(result).toContain('type = "mysql"');
    expect(result).toContain('host = "mysql.local"');
  });

  it('outputs ssl and socket fields in database sections', () => {
    const result = buildConfigToml({
      databases: {
        local_pg: {
          type: 'postgres',
          database: 'dev',
          socket: '/var/run/postgresql/.s.PGSQL.5432',
          ssl: true,
        },
      },
    });
    expect(result).toContain('[databases.local_pg]');
    expect(result).toContain('socket = "/var/run/postgresql/.s.PGSQL.5432"');
    expect(result).toContain('ssl = true');
  });
});

describe('convertTomlDatabases', () => {
  it('converts a valid database entry', () => {
    const result = convertTomlDatabases({
      analytics: {
        type: 'postgres',
        database: 'analytics',
        host: 'db.example.com',
        port: 5432,
        user: 'reader',
      },
    });
    expect(result).toEqual({
      analytics: {
        type: 'postgres',
        database: 'analytics',
        host: 'db.example.com',
        port: 5432,
        user: 'reader',
      },
    });
  });

  it('skips entries missing required "type" field', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = convertTomlDatabases({
      bad: { database: 'something' } as never,
    });
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping database "bad"'));
    warnSpy.mockRestore();
  });

  it('skips entries missing required "database" field', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = convertTomlDatabases({
      bad: { type: 'postgres' } as never,
    });
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping database "bad"'));
    warnSpy.mockRestore();
  });

  it('clamps max_rows to 1,000,000', () => {
    const result = convertTomlDatabases({
      big: { type: 'postgres', database: 'db', max_rows: 5_000_000 },
    });
    expect(result.big?.max_rows).toBe(1_000_000);
  });

  it('ignores non-positive max_rows', () => {
    const result = convertTomlDatabases({
      zero: { type: 'postgres', database: 'db', max_rows: 0 },
      neg: { type: 'postgres', database: 'db', max_rows: -10 },
    });
    expect(result.zero?.max_rows).toBeUndefined();
    expect(result.neg?.max_rows).toBeUndefined();
  });

  it('ignores non-positive query_timeout', () => {
    const result = convertTomlDatabases({
      zero: { type: 'postgres', database: 'db', query_timeout: 0 },
      neg: { type: 'postgres', database: 'db', query_timeout: -5 },
    });
    expect(result.zero?.query_timeout).toBeUndefined();
    expect(result.neg?.query_timeout).toBeUndefined();
  });

  it('accepts valid query_timeout and max_rows', () => {
    const result = convertTomlDatabases({
      ok: { type: 'mysql', database: 'app', query_timeout: 60, max_rows: 500 },
    });
    expect(result.ok?.query_timeout).toBe(60);
    expect(result.ok?.max_rows).toBe(500);
  });

  it('passes through optional fields (socket, ssl, snowflake, bigquery)', () => {
    const result = convertTomlDatabases({
      full: {
        type: 'postgres',
        database: 'db',
        host: 'h',
        port: 5432,
        user: 'u',
        socket: '/tmp/.s.PGSQL.5432',
        ssl: true,
        account: 'acct',
        warehouse: 'wh',
        role: 'r',
        schema: 's',
        project: 'p',
        credentials_file: '/path/to/creds.json',
      },
    });
    const conn = result.full;
    expect(conn).toBeDefined();
    expect(conn?.socket).toBe('/tmp/.s.PGSQL.5432');
    expect(conn?.ssl).toBe(true);
    expect(conn?.account).toBe('acct');
    expect(conn?.warehouse).toBe('wh');
    expect(conn?.role).toBe('r');
    expect(conn?.schema).toBe('s');
    expect(conn?.project).toBe('p');
    expect(conn?.credentials_file).toBe('/path/to/creds.json');
  });
});
