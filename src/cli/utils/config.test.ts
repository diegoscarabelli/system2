import TOML from '@iarna/toml';
import { describe, expect, it, vi } from 'vitest';
import {
  buildConfigToml,
  convertTomlAgents,
  convertTomlDatabases,
  convertTomlDelivery,
  convertTomlLlm,
  convertTomlSession,
  DEFAULT_DELIVERY,
  DEFAULT_SESSION,
  DEFAULT_WEB_SEARCH_MAX_RESULTS,
  validateAgentModels,
  validateLlmModels,
} from './config.js';

describe('buildConfigToml', () => {
  // 0.3.0 split: this emitter writes ONLY user-managed sections. Auth-managed
  // sections (`[llm.*]`, `[services.*]`, `[tools.web_search]` enabled flag)
  // live in auth.toml and are NEVER emitted here.
  it('does not emit any auth-managed sections', () => {
    const result = buildConfigToml({});
    expect(result).not.toMatch(/^\[llm\./m);
    expect(result).not.toMatch(/^\[services\./m);
    expect(result).not.toMatch(/^\[tools\.web_search\]/m);
    // Even commented stubs are gone — auth.toml owns those.
    expect(result).not.toMatch(/^# \[llm\./m);
    expect(result).not.toMatch(/^# \[services\./m);
  });

  it('header points the user to auth.toml for credentials', () => {
    const result = buildConfigToml({});
    expect(result).toMatch(/auth\.toml/);
    expect(result).toMatch(/system2 config/);
  });

  it('emits commented web_search_max_results scalar at code default', () => {
    const result = buildConfigToml({});
    expect(result).toContain(`# web_search_max_results = ${DEFAULT_WEB_SEARCH_MAX_RESULTS}`);
    // Live (uncommented) scalar must NOT be present in default template.
    expect(result).not.toMatch(/^web_search_max_results = /m);
  });

  // Operational settings are always emitted as commented templates
  // (header + key = value, both prefixed with `#`). Values come from
  // DEFAULT_OPERATIONAL / DEFAULT_SESSION / DEFAULT_DELIVERY in code. Users
  // tune them by hand-editing the toml; the emitter is not the path for
  // customization. This guards against accidental edits silently changing
  // behavior — if a line stays commented, the runtime falls back to the
  // pinned code default, so a default bump propagates automatically.
  it('emits operational sections as commented defaults', () => {
    const result = buildConfigToml({});
    // Header lines themselves are commented.
    expect(result).toMatch(/^# \[backup\]$/m);
    expect(result).toMatch(/^# \[logs\]$/m);
    expect(result).toMatch(/^# \[scheduler\]$/m);
    expect(result).toMatch(/^# \[chat\]$/m);
    expect(result).toMatch(/^# \[knowledge\]$/m);
    expect(result).toMatch(/^# \[session\]$/m);
    expect(result).toMatch(/^# \[delivery\]$/m);
    // Default values appear, but commented.
    expect(result).toContain('# cooldown_hours = 24');
    expect(result).toContain('# max_backups = 3');
    expect(result).toContain('# rotation_threshold_mb = 10');
    expect(result).toContain('# max_archives = 5');
    expect(result).toContain('# daily_summary_interval_minutes = 30');
    expect(result).toContain('# max_history_messages = 100');
    expect(result).toContain(`# rotation_size_bytes = ${DEFAULT_SESSION.rotation_size_bytes}`);
    expect(result).toContain(`# max_bytes = ${DEFAULT_DELIVERY.max_bytes}`);
    // No live (uncommented) operational headers.
    expect(result).not.toMatch(/^\[backup\]$/m);
    expect(result).not.toMatch(/^\[delivery\]$/m);
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

  it('shows commented database hint when no databases configured', () => {
    const result = buildConfigToml({});
    expect(result).toContain('# [databases.');
    expect(result).not.toMatch(/^\[databases\./m);
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

  it('includes agents section with thinking_level and compaction_depth', () => {
    const result = buildConfigToml({
      agents: {
        guide: {
          thinking_level: 'medium',
          compaction_depth: 5,
        },
      },
    });
    expect(result).toContain('[agents.guide]');
    expect(result).toContain('thinking_level = "medium"');
    expect(result).toContain('compaction_depth = 5');
  });

  it('emits [agents.<role>] block with scalar fields', () => {
    const result = buildConfigToml({
      agents: {
        guide: { thinking_level: 'high', compaction_depth: 3 },
      },
    });
    expect(result).toContain('[agents.guide]');
    expect(result).toContain('thinking_level = "high"');
    expect(result).toContain('compaction_depth = 3');
  });

  it('emits multiple agent role overrides', () => {
    const result = buildConfigToml({
      agents: {
        guide: { thinking_level: 'medium' },
        conductor: { compaction_depth: 8 },
      },
    });
    expect(result).toContain('[agents.guide]');
    expect(result).toContain('thinking_level = "medium"');
    expect(result).toContain('[agents.conductor]');
    expect(result).toContain('compaction_depth = 8');
  });

  it('shows commented agents hint when not configured', () => {
    const result = buildConfigToml({});
    expect(result).toContain('# [agents.');
    expect(result).not.toMatch(/^\[agents\./m);
    // Model-pin hints live in their tier sections now, not under agents.
    expect(result).not.toMatch(/# Per-role model pins.*live under/);
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

describe('convertTomlAgents', () => {
  it('converts valid overrides with both fields', () => {
    const result = convertTomlAgents({
      guide: { thinking_level: 'high', compaction_depth: 3 },
    });
    expect(result).toEqual({ guide: { thinking_level: 'high', compaction_depth: 3 } });
  });

  it('converts partial overrides (only thinking_level)', () => {
    const result = convertTomlAgents({
      conductor: { thinking_level: 'low' },
    });
    expect(result).toEqual({ conductor: { thinking_level: 'low' } });
  });

  it('ignores invalid thinking_level with warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = convertTomlAgents({
      guide: { thinking_level: 'turbo' as never },
    });
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring invalid thinking_level')
    );
    warnSpy.mockRestore();
  });

  it('rejects non-integer compaction_depth with warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = convertTomlAgents({
      guide: { compaction_depth: 2.5 },
    });
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring invalid compaction_depth')
    );
    warnSpy.mockRestore();
  });

  it('rejects negative compaction_depth with warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = convertTomlAgents({
      guide: { compaction_depth: -1 },
    });
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring invalid compaction_depth')
    );
    warnSpy.mockRestore();
  });

  it('skips roles with no valid overrides', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = convertTomlAgents({
      guide: { thinking_level: 'bogus' as never },
      conductor: { thinking_level: 'medium' },
    });
    expect(result).toEqual({ conductor: { thinking_level: 'medium' } });
    warnSpy.mockRestore();
  });

  it('handles multiple roles', () => {
    const result = convertTomlAgents({
      guide: { thinking_level: 'high', compaction_depth: 5 },
      conductor: { compaction_depth: 8 },
      narrator: { thinking_level: 'off' },
    });
    expect(result).toEqual({
      guide: { thinking_level: 'high', compaction_depth: 5 },
      conductor: { compaction_depth: 8 },
      narrator: { thinking_level: 'off' },
    });
  });
});

describe('validateLlmModels', () => {
  it('passes when OAuth pin and api-keys per-role pins are in catalog', () => {
    expect(() =>
      validateLlmModels({
        primary: 'anthropic',
        fallback: [],
        providers: {
          anthropic: {
            keys: [],
            models: { narrator: 'claude-haiku-4-5-20251001' },
          },
        },
        oauth: {
          primary: 'anthropic',
          fallback: [],
          providers: { anthropic: { model: 'claude-opus-4-7' } },
        },
      })
    ).not.toThrow();
  });

  it('throws on unknown OAuth model with did-you-mean hint', () => {
    expect(() =>
      validateLlmModels({
        primary: 'anthropic',
        fallback: [],
        providers: {},
        oauth: {
          primary: 'anthropic',
          fallback: [],
          providers: { anthropic: { model: 'claude-opus-4-99' } },
        },
      })
    ).toThrow(/\[llm\.oauth\.anthropic\]\.model.*Did you mean/);
  });

  it('throws on unknown api-keys per-role model with did-you-mean hint', () => {
    expect(() =>
      validateLlmModels({
        primary: 'anthropic',
        fallback: [],
        providers: {
          anthropic: { keys: [], models: { narrator: 'claude-opus-4-99' } },
        },
      })
    ).toThrow(/\[llm\.api_keys\.anthropic\.models\]\.narrator.*Did you mean/);
  });

  it('throws on unknown provider in OAuth pin', () => {
    expect(() =>
      validateLlmModels({
        primary: 'anthropic',
        fallback: [],
        providers: {},
        oauth: {
          primary: 'anthropic',
          fallback: [],
          providers: { anthopic: { model: 'claude-opus-4-7' } } as never,
        },
      })
    ).toThrow(/unknown provider "anthopic"/);
  });

  it('is a no-op when neither OAuth nor api-keys carry model pins', () => {
    expect(() =>
      validateLlmModels({
        primary: 'anthropic',
        fallback: [],
        providers: { anthropic: { keys: [{ key: 'sk-x', label: 'main' }] } },
      })
    ).not.toThrow();
  });
});

describe('convertTomlLlm — new shape', () => {
  it('parses [llm.oauth.<provider>].model overrides', () => {
    const llm = convertTomlLlm({
      oauth: {
        primary: 'anthropic',
        fallback: [],
        anthropic: { model: 'claude-opus-4-7' },
      },
      api_keys: { primary: 'anthropic', fallback: [] },
    });
    expect(llm.oauth?.providers.anthropic?.model).toBe('claude-opus-4-7');
  });

  it('skips OAuth provider entries without a model field', () => {
    const llm = convertTomlLlm({
      oauth: {
        primary: 'anthropic',
        fallback: [],
        anthropic: { model: 'claude-opus-4-7' },
        'openai-codex': {},
      },
      api_keys: { primary: 'anthropic', fallback: [] },
    });
    expect(llm.oauth?.providers).toEqual({ anthropic: { model: 'claude-opus-4-7' } });
  });

  it('parses [llm.api_keys.<provider>.models][<role>] per-role pins', () => {
    const llm = convertTomlLlm({
      api_keys: {
        primary: 'anthropic',
        fallback: [],
        anthropic: {
          keys: [{ key: 'sk-x', label: 'main' }],
          models: { narrator: 'claude-haiku-4-5-20251001' },
        },
      },
    });
    expect(llm.providers.anthropic?.models?.narrator).toBe('claude-haiku-4-5-20251001');
  });

  it('omits api-keys models field when not set', () => {
    const llm = convertTomlLlm({
      api_keys: {
        primary: 'anthropic',
        fallback: [],
        anthropic: { keys: [{ key: 'sk-x', label: 'main' }] },
      },
    });
    expect(llm.providers.anthropic?.models).toBeUndefined();
  });

  it('throws on unknown [llm.api_keys].primary provider', () => {
    expect(() => convertTomlLlm({ api_keys: { primary: 'anthrpic', fallback: [] } })).toThrow(
      /\[llm\.api_keys\]\.primary.*not a supported API keys provider/
    );
  });

  it('throws on unknown entry in [llm.api_keys].fallback', () => {
    expect(() =>
      convertTomlLlm({ api_keys: { primary: 'anthropic', fallback: ['oops'] } })
    ).toThrow(/\[llm\.api_keys\]\.fallback\[0\].*not a supported API keys provider/);
  });

  it('throws on unknown [llm.oauth].primary provider', () => {
    expect(() =>
      convertTomlLlm({
        oauth: { primary: 'gemini-cli', fallback: [] },
        api_keys: { primary: 'anthropic', fallback: [] },
      })
    ).toThrow(/\[llm\.oauth\]\.primary.*not a supported OAuth provider/);
  });

  it('throws when [llm.oauth.<p>] pin exists without [llm.oauth].primary', () => {
    // User wrote `[llm.oauth.anthropic] model = "..."` but forgot the
    // `[llm.oauth] primary = "..."` table. Before this guard the pin would
    // be silently ignored (OAuth tier disabled), which is hard to debug.
    expect(() =>
      convertTomlLlm({
        oauth: { anthropic: { model: 'claude-opus-4-7' } },
        api_keys: { primary: 'anthropic', fallback: [] },
      })
    ).toThrow(/anthropic.*\[llm\.oauth\]\.primary is missing/);
  });

  it('does not throw when [llm.oauth] is entirely absent', () => {
    // Distinct from the orphan-pin case: no oauth table at all means the
    // user has explicitly chosen api-keys-only. Don't surface an error.
    expect(() =>
      convertTomlLlm({ api_keys: { primary: 'anthropic', fallback: [] } })
    ).not.toThrow();
  });

  it('rejects an api-keys-only provider in [llm.oauth].fallback', () => {
    // openai is api-keys-only; OAuth tier supports openai-codex instead.
    expect(() =>
      convertTomlLlm({
        oauth: { primary: 'anthropic', fallback: ['openai'] },
        api_keys: { primary: 'anthropic', fallback: [] },
      })
    ).toThrow(/\[llm\.oauth\]\.fallback\[0\].*not a supported OAuth provider/);
  });
});

describe('convertTomlDelivery', () => {
  it('reads valid config correctly with all fields present', () => {
    const result = convertTomlDelivery({
      max_bytes: 1048576,
      catch_up_budget_bytes: 524288,
      narrator_message_excerpt_bytes: 8192,
    });
    expect(result).toEqual({
      max_bytes: 1048576,
      catch_up_budget_bytes: 524288,
      narrator_message_excerpt_bytes: 8192,
    });
  });

  it('applies defaults for missing keys', () => {
    const result = convertTomlDelivery({});
    expect(result).toEqual(DEFAULT_DELIVERY);
  });

  it('applies default for a single missing key, keeps valid keys', () => {
    const result = convertTomlDelivery({ max_bytes: 2097152 });
    expect(result.max_bytes).toBe(2097152);
    expect(result.catch_up_budget_bytes).toBe(DEFAULT_DELIVERY.catch_up_budget_bytes);
    expect(result.narrator_message_excerpt_bytes).toBe(
      DEFAULT_DELIVERY.narrator_message_excerpt_bytes
    );
  });

  it('warns and uses default for a non-positive value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = convertTomlDelivery({ max_bytes: 0 });
    expect(result.max_bytes).toBe(DEFAULT_DELIVERY.max_bytes);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('delivery.max_bytes'));
    warnSpy.mockRestore();
  });

  it('warns and uses default for a negative value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = convertTomlDelivery({ catch_up_budget_bytes: -1 });
    expect(result.catch_up_budget_bytes).toBe(DEFAULT_DELIVERY.catch_up_budget_bytes);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('delivery.catch_up_budget_bytes'));
    warnSpy.mockRestore();
  });

  it('warns and uses default for a non-integer value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = convertTomlDelivery({ max_bytes: 1.5 });
    expect(result.max_bytes).toBe(DEFAULT_DELIVERY.max_bytes);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('delivery.max_bytes'));
    warnSpy.mockRestore();
  });

  it('warns and clamps when catch_up_budget_bytes >= max_bytes', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = convertTomlDelivery({ max_bytes: 1024, catch_up_budget_bytes: 1024 });
    // Clamp to max_bytes - 1 to keep the producer budget strictly below the transport cap
    // while preserving as much of the user-configured budget as possible.
    expect(result.max_bytes).toBe(1024);
    expect(result.catch_up_budget_bytes).toBe(1023);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('catch_up_budget_bytes'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('clamped to 1023'));
    warnSpy.mockRestore();
  });

  it('preserves user budget by clamping to max_bytes - 1 when budget == max_bytes', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // max_bytes = 10 MB and catch_up_budget_bytes = 10 MB. The clamp must preserve as much
    // of the user budget as possible, ending at 10 MB - 1 (not the 512 KB default).
    const tenMb = 10 * 1024 * 1024;
    const result = convertTomlDelivery({
      max_bytes: tenMb,
      catch_up_budget_bytes: tenMb,
    });
    expect(result.max_bytes).toBe(tenMb);
    expect(result.catch_up_budget_bytes).toBe(tenMb - 1);
    expect(result.catch_up_budget_bytes).toBe(10485759);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`clamped to ${tenMb - 1}`));
    warnSpy.mockRestore();
  });

  it('does not warn when catch_up_budget_bytes < max_bytes', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    convertTomlDelivery({ max_bytes: 2048, catch_up_budget_bytes: 1024 });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('convertTomlSession', () => {
  it('reads valid config correctly with all fields set', () => {
    const result = convertTomlSession({
      rotation_size_bytes: 5 * 1024 * 1024,
      archive_keep_count: 8,
    });
    expect(result).toEqual({
      rotation_size_bytes: 5 * 1024 * 1024,
      archive_keep_count: 8,
    });
  });

  it('applies defaults for missing keys', () => {
    const result = convertTomlSession({});
    expect(result).toEqual(DEFAULT_SESSION);
  });

  it('preserves user-configured value when valid', () => {
    const result = convertTomlSession({
      rotation_size_bytes: 20 * 1024 * 1024,
    });
    expect(result.rotation_size_bytes).toBe(20 * 1024 * 1024);
    // Missing archive_keep_count falls back to the default.
    expect(result.archive_keep_count).toBe(DEFAULT_SESSION.archive_keep_count);
  });

  it('warns and uses default for non-positive rotation_size_bytes', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = convertTomlSession({ rotation_size_bytes: 0 });
    expect(result.rotation_size_bytes).toBe(DEFAULT_SESSION.rotation_size_bytes);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session.rotation_size_bytes'));
    warnSpy.mockRestore();
  });

  it('warns and uses default for non-integer rotation_size_bytes', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = convertTomlSession({ rotation_size_bytes: 1.5 });
    expect(result.rotation_size_bytes).toBe(DEFAULT_SESSION.rotation_size_bytes);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session.rotation_size_bytes'));
    warnSpy.mockRestore();
  });

  it('warns and uses default for negative value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = convertTomlSession({ rotation_size_bytes: -1024 });
    expect(result.rotation_size_bytes).toBe(DEFAULT_SESSION.rotation_size_bytes);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session.rotation_size_bytes'));
    warnSpy.mockRestore();
  });

  it('does not warn when rotation_size_bytes is a valid positive integer', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    convertTomlSession({ rotation_size_bytes: 10 * 1024 * 1024 });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('preserves a valid archive_keep_count', () => {
    const result = convertTomlSession({ archive_keep_count: 12 });
    expect(result.archive_keep_count).toBe(12);
    expect(result.rotation_size_bytes).toBe(DEFAULT_SESSION.rotation_size_bytes);
  });

  it('warns and uses default for non-positive archive_keep_count', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = convertTomlSession({ archive_keep_count: 0 });
    expect(result.archive_keep_count).toBe(DEFAULT_SESSION.archive_keep_count);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session.archive_keep_count'));
    warnSpy.mockRestore();
  });

  it('warns and uses default for negative archive_keep_count', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = convertTomlSession({ archive_keep_count: -3 });
    expect(result.archive_keep_count).toBe(DEFAULT_SESSION.archive_keep_count);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session.archive_keep_count'));
    warnSpy.mockRestore();
  });

  it('warns and uses default for non-integer archive_keep_count', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = convertTomlSession({ archive_keep_count: 5.7 });
    expect(result.archive_keep_count).toBe(DEFAULT_SESSION.archive_keep_count);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session.archive_keep_count'));
    warnSpy.mockRestore();
  });

  it('does not warn when archive_keep_count is a valid positive integer', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    convertTomlSession({ archive_keep_count: 5 });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('buildConfigToml — [session] section', () => {
  it('emits [session] as a commented template (defaults pinned in code)', () => {
    const result = buildConfigToml({});
    expect(result).toMatch(/^# \[session\]$/m);
    expect(result).toContain(`# rotation_size_bytes = ${DEFAULT_SESSION.rotation_size_bytes}`);
    expect(result).toContain(`# archive_keep_count = ${DEFAULT_SESSION.archive_keep_count}`);
    // No live header — runtime falls back to DEFAULT_SESSION when commented.
    expect(result).not.toMatch(/^\[session\]$/m);
  });

  it('round-trips a hand-built [session] section through convertTomlSession', () => {
    const input = {
      rotation_size_bytes: 15 * 1024 * 1024,
      archive_keep_count: 7,
    };
    const toml = `[session]\nrotation_size_bytes = ${input.rotation_size_bytes}\narchive_keep_count = ${input.archive_keep_count}\n`;
    const parsed = TOML.parse(toml) as Record<string, unknown>;
    const sessionSection = parsed.session as Parameters<typeof convertTomlSession>[0];
    expect(convertTomlSession(sessionSection)).toEqual(input);
  });
});

describe('buildConfigToml — [delivery] section', () => {
  it('emits [delivery] as a commented template (defaults pinned in code)', () => {
    const result = buildConfigToml({});
    expect(result).toMatch(/^# \[delivery\]$/m);
    expect(result).toContain(`# max_bytes = ${DEFAULT_DELIVERY.max_bytes}`);
    expect(result).toContain(`# catch_up_budget_bytes = ${DEFAULT_DELIVERY.catch_up_budget_bytes}`);
    expect(result).toContain(
      `# narrator_message_excerpt_bytes = ${DEFAULT_DELIVERY.narrator_message_excerpt_bytes}`
    );
    expect(result).not.toMatch(/^\[delivery\]$/m);
  });

  it('round-trips a hand-built [delivery] section through convertTomlDelivery', () => {
    const input = {
      max_bytes: 2097152,
      catch_up_budget_bytes: 1048576,
      narrator_message_excerpt_bytes: 16384,
    };
    const toml = `[delivery]\nmax_bytes = ${input.max_bytes}\ncatch_up_budget_bytes = ${input.catch_up_budget_bytes}\nnarrator_message_excerpt_bytes = ${input.narrator_message_excerpt_bytes}\n`;
    const parsed = TOML.parse(toml) as Record<string, unknown>;
    const deliverySection = parsed.delivery as Parameters<typeof convertTomlDelivery>[0];
    expect(convertTomlDelivery(deliverySection)).toEqual(input);
  });
});

describe('validateAgentModels', () => {
  it('passes when all models are in pi-ai catalog', () => {
    expect(() =>
      validateAgentModels({
        narrator: { anthropic: 'claude-haiku-4-5-20251001', openai: 'gpt-4o-mini' },
      })
    ).not.toThrow();
  });

  it('passes for the new OAuth providers when models exist in their catalogs', () => {
    expect(() =>
      validateAgentModels({
        conductor: {
          'openai-codex': 'gpt-5.3-codex',
          'github-copilot': 'claude-sonnet-4.6',
        },
      })
    ).not.toThrow();
  });

  it('throws with did-you-mean suggestion on a model typo', () => {
    expect(() => validateAgentModels({ narrator: { anthropic: 'claude-sonet-4-6' } })).toThrow(
      /Did you mean ".*claude.*"/i
    );
  });

  it('throws when model is not in catalog and no close match exists', () => {
    expect(() =>
      validateAgentModels({ narrator: { anthropic: 'totally-fake-model-xyz' } })
    ).toThrow(/not in pi-ai's catalog/);
  });

  it('throws for openai-compatible (not allowed as a per-agent override)', () => {
    expect(() =>
      validateAgentModels({ narrator: { 'openai-compatible': 'whatever-local-model' } })
    ).toThrow(/unknown provider "openai-compatible"/);
  });

  it('throws on unknown provider id (e.g., a typo) instead of silently skipping', () => {
    expect(() => validateAgentModels({ narrator: { anthopic: 'claude-sonnet-4-6' } })).toThrow(
      /unknown provider "anthopic"/
    );
  });

  it('throws on unknown provider with the list of valid providers in the message', () => {
    expect(() => validateAgentModels({ narrator: { 'imaginary-provider': 'foo' } })).toThrow(
      /Valid providers:.*anthropic.*openai-codex/
    );
  });

  it('treats empty models map as no-op', () => {
    expect(() => validateAgentModels({ narrator: {} })).not.toThrow();
  });
});
