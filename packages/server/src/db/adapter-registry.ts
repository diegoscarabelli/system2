/**
 * Database Adapter Registry
 *
 * Routes queries to the appropriate database adapter by name.
 * The built-in 'system2' database (app.db) is registered automatically
 * by wrapping DatabaseClient.query(). External databases are created
 * lazily from config on first query.
 */

import type { DatabasesConfig } from '@dscarabelli/shared';
import type { AdapterFactory, DatabaseAdapter } from './adapter.js';
import type { DatabaseClient } from './client.js';

const DEFAULT_MAX_ROWS = 10_000;

export class DatabaseAdapterRegistry {
  private adapters = new Map<string, DatabaseAdapter>();
  private pending = new Map<string, Promise<DatabaseAdapter>>();
  private configs: DatabasesConfig;

  private static factories: Record<string, () => Promise<AdapterFactory>> = {
    postgres: async () => (await import('./adapters/postgres.js')).createAdapter,
    mysql: async () => (await import('./adapters/mysql.js')).createAdapter,
    sqlite: async () => (await import('./adapters/sqlite.js')).createAdapter,
    mssql: async () => (await import('./adapters/mssql.js')).createAdapter,
    clickhouse: async () => (await import('./adapters/clickhouse.js')).createAdapter,
    duckdb: async () => (await import('./adapters/duckdb.js')).createAdapter,
    snowflake: async () => (await import('./adapters/snowflake.js')).createAdapter,
    bigquery: async () => (await import('./adapters/bigquery.js')).createAdapter,
  };

  constructor(configs: DatabasesConfig | undefined, db: DatabaseClient) {
    this.configs = configs ?? {};
    // Prevent config from shadowing the built-in system2 adapter
    delete this.configs.system2;
    // Register app.db as 'system2' by wrapping the existing DatabaseClient.query()
    this.adapters.set('system2', {
      engine: 'sqlite',
      connected: true,
      connect: async () => {},
      disconnect: async () => {},
      query: async (sql: string) => {
        const rows = db.query(sql);
        return rows.slice(0, DEFAULT_MAX_ROWS);
      },
    });
  }

  async query(name: string, sql: string): Promise<unknown[]> {
    let adapter = this.adapters.get(name);

    if (!adapter) {
      // Check for an in-flight creation to avoid duplicate adapters from concurrent queries
      const inflight = this.pending.get(name);
      if (inflight) {
        adapter = await inflight;
      } else {
        const promise = this.createAdapter(name);
        this.pending.set(name, promise);
        try {
          adapter = await promise;
        } finally {
          this.pending.delete(name);
        }
      }
    }

    if (!adapter.connected) {
      await adapter.connect();
    }

    return adapter.query(sql);
  }

  listDatabases(): string[] {
    return ['system2', ...Object.keys(this.configs)];
  }

  async disconnectAll(): Promise<void> {
    this.pending.clear();
    const system2 = this.adapters.get('system2');
    for (const [name, adapter] of this.adapters) {
      if (name === 'system2') continue; // lifecycle managed by Server
      try {
        await adapter.disconnect();
      } catch {
        // best-effort cleanup during shutdown
      }
    }
    this.adapters.clear();
    if (system2) this.adapters.set('system2', system2);
  }

  private async createAdapter(name: string): Promise<DatabaseAdapter> {
    const config = this.configs[name];
    if (!config) {
      const configured = [...Object.keys(this.configs), 'system2'];
      throw new Error(`Unknown database "${name}". Available databases: ${configured.join(', ')}`);
    }

    const factoryLoader = DatabaseAdapterRegistry.factories[config.type];
    if (!factoryLoader) {
      const supported = Object.keys(DatabaseAdapterRegistry.factories);
      throw new Error(
        `Unsupported database type "${config.type}". Supported types: ${supported.join(', ')}`
      );
    }

    const factory = await factoryLoader();
    const adapter = factory(config);
    this.adapters.set(name, adapter);
    return adapter;
  }
}
