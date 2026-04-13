import type { DatabaseConnectionConfig, DatabasesConfig } from '@dscarabelli/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterFactory, DatabaseAdapter } from './adapter.js';
import { DatabaseAdapterRegistry, DatabaseConfigError } from './adapter-registry.js';

// Minimal mock for DatabaseClient: only needs query()
function makeMockDb() {
  return { query: vi.fn(() => [{ id: 1 }]) };
}

// Build a fake adapter that records calls for assertions
function makeFakeAdapter(overrides?: Partial<DatabaseAdapter>): DatabaseAdapter {
  return {
    engine: 'test',
    connected: false,
    connect: vi.fn(async () => {}),
    query: vi.fn(async () => [{ fake: true }]),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  };
}

// Mock the dynamic adapter imports so no real drivers are needed
vi.mock('./adapters/postgres.js', () => {
  const adapter = makeFakeAdapter({ engine: 'postgres' });
  const createAdapter: AdapterFactory = () => adapter;
  return { createAdapter, __testAdapter: adapter };
});

vi.mock('./adapters/mysql.js', () => {
  const adapter = makeFakeAdapter({ engine: 'mysql' });
  const createAdapter: AdapterFactory = () => adapter;
  return { createAdapter, __testAdapter: adapter };
});

vi.mock('./adapters/sqlite.js', () => {
  const adapter = makeFakeAdapter({ engine: 'sqlite' });
  const createAdapter: AdapterFactory = () => adapter;
  return { createAdapter, __testAdapter: adapter };
});

vi.mock('./adapters/mssql.js', () => {
  const adapter = makeFakeAdapter({ engine: 'mssql' });
  const createAdapter: AdapterFactory = () => adapter;
  return { createAdapter, __testAdapter: adapter };
});

vi.mock('./adapters/clickhouse.js', () => {
  const adapter = makeFakeAdapter({ engine: 'clickhouse' });
  const createAdapter: AdapterFactory = () => adapter;
  return { createAdapter, __testAdapter: adapter };
});

vi.mock('./adapters/duckdb.js', () => {
  const adapter = makeFakeAdapter({ engine: 'duckdb' });
  const createAdapter: AdapterFactory = () => adapter;
  return { createAdapter, __testAdapter: adapter };
});

vi.mock('./adapters/snowflake.js', () => {
  const adapter = makeFakeAdapter({ engine: 'snowflake' });
  const createAdapter: AdapterFactory = () => adapter;
  return { createAdapter, __testAdapter: adapter };
});

vi.mock('./adapters/bigquery.js', () => {
  const adapter = makeFakeAdapter({ engine: 'bigquery' });
  const createAdapter: AdapterFactory = () => adapter;
  return { createAdapter, __testAdapter: adapter };
});

describe('DatabaseAdapterRegistry', () => {
  let db: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    db = makeMockDb();
  });

  describe('system2 built-in database', () => {
    it('is always available and routes through db.query()', async () => {
      const registry = new DatabaseAdapterRegistry(undefined, db as never);

      const result = await registry.query('system2', 'SELECT 1');

      expect(db.query).toHaveBeenCalledWith('SELECT 1');
      expect(result).toEqual([{ id: 1 }]);
    });
  });

  describe('unknown database', () => {
    it('throws DatabaseConfigError with available databases listed', async () => {
      const configs: DatabasesConfig = {
        analytics: { type: 'postgres', database: 'analytics' },
      };
      const registry = new DatabaseAdapterRegistry(configs, db as never);

      const error = await registry.query('nope', 'SELECT 1').catch((e) => e);
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toBe(
        'Unknown database "nope". Available databases: analytics, system2'
      );
    });
  });

  describe('unsupported engine type', () => {
    it('throws DatabaseConfigError with supported types listed', async () => {
      const configs: DatabasesConfig = {
        oracle: { type: 'oracle', database: 'orcl' } as DatabaseConnectionConfig,
      };
      const registry = new DatabaseAdapterRegistry(configs, db as never);

      const error = await registry.query('oracle', 'SELECT 1').catch((e) => e);
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toMatch(
        /Unsupported database type "oracle"\. Supported types: postgres, mysql, sqlite/
      );
    });
  });

  describe('listDatabases()', () => {
    it('returns system2 plus configured names', () => {
      const configs: DatabasesConfig = {
        analytics: { type: 'postgres', database: 'analytics' },
        warehouse: { type: 'mysql', database: 'warehouse' },
      };
      const registry = new DatabaseAdapterRegistry(configs, db as never);

      expect(registry.listDatabases()).toEqual(['system2', 'analytics', 'warehouse']);
    });

    it('returns only system2 when no external databases are configured', () => {
      const registry = new DatabaseAdapterRegistry(undefined, db as never);

      expect(registry.listDatabases()).toEqual(['system2']);
    });
  });

  describe('disconnectAll()', () => {
    it('calls disconnect on external adapters but not system2', async () => {
      const configs: DatabasesConfig = {
        analytics: { type: 'postgres', database: 'analytics' },
      };
      const registry = new DatabaseAdapterRegistry(configs, db as never);

      // Force the external adapter to be created by querying it
      await registry.query('analytics', 'SELECT 1');

      // Retrieve the mock adapter so we can check disconnect later
      const { __testAdapter: pgAdapter } = (await import('./adapters/postgres.js')) as unknown as {
        __testAdapter: DatabaseAdapter;
      };

      await registry.disconnectAll();

      expect(pgAdapter.disconnect).toHaveBeenCalled();
      // system2 adapter.disconnect should never be called (lifecycle managed by Server)
    });

    it('preserves system2 adapter after disconnectAll', async () => {
      const configs: DatabasesConfig = {
        analytics: { type: 'postgres', database: 'analytics' },
      };
      const registry = new DatabaseAdapterRegistry(configs, db as never);

      await registry.disconnectAll();

      // system2 should still work
      const result = await registry.query('system2', 'SELECT 1');
      expect(result).toEqual([{ id: 1 }]);
    });
  });
});
