/**
 * PostgreSQL Adapter
 *
 * Wraps the pg module (dynamically loaded from ~/.system2/node_modules/)
 * behind the DatabaseAdapter interface. Creates a Pool lazily on first query
 * and tears it down after 5 minutes of inactivity.
 */

import type { DatabaseConnectionConfig } from '../../../shared/index.js';
import type { AdapterFactory, DatabaseAdapter } from '../adapter.js';
import { loadDriver } from '../driver-loader.js';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export const createAdapter: AdapterFactory = (
  config: DatabaseConnectionConfig
): DatabaseAdapter => {
  // biome-ignore lint/suspicious/noExplicitAny: pg is dynamically loaded, no static types available
  let pool: any = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const timeoutMs = (config.query_timeout ?? 30) * 1000;
  const maxRows = config.max_rows ?? 10_000;

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (pool) {
        pool.end().catch(() => {});
        pool = null;
      }
    }, IDLE_TIMEOUT_MS);
  }

  function ensurePool(): void {
    if (pool) return;

    // biome-ignore lint/suspicious/noExplicitAny: pg is dynamically loaded
    const pg = loadDriver('pg') as any;
    pool = new pg.Pool({
      host: config.socket ?? config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? true : undefined,
      max: 5,
    });
  }

  const adapter: DatabaseAdapter = {
    engine: 'postgres',

    get connected(): boolean {
      return pool !== null;
    },

    async connect(): Promise<void> {
      ensurePool();
      // Verify connectivity with a lightweight round-trip
      const client = await pool.connect();
      client.release();
      resetIdleTimer();
    },

    async query(sql: string): Promise<unknown[]> {
      ensurePool();
      resetIdleTimer();

      const client = await pool.connect();
      try {
        await client.query(`SET statement_timeout = ${timeoutMs}`);
        const result = await client.query(sql);
        const rows = result.rows as unknown[];
        return rows.slice(0, maxRows);
      } finally {
        client.release();
      }
    },

    async disconnect(): Promise<void> {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (pool) {
        await pool.end();
        pool = null;
      }
    },
  };

  return adapter;
};
