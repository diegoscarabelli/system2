/**
 * MySQL Adapter
 *
 * Wraps mysql2/promise (dynamically loaded from ~/.system2/node_modules/)
 * behind the DatabaseAdapter interface. Creates a connection pool lazily
 * on first query and tears it down after 5 minutes of inactivity.
 */

import type { DatabaseConnectionConfig } from '@dscarabelli/shared';
import type { AdapterFactory, DatabaseAdapter } from '../adapter.js';
import { loadDriver } from '../driver-loader.js';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export const createAdapter: AdapterFactory = (
  config: DatabaseConnectionConfig
): DatabaseAdapter => {
  // biome-ignore lint/suspicious/noExplicitAny: mysql2 is dynamically loaded, no static types available
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

    // biome-ignore lint/suspicious/noExplicitAny: mysql2 is dynamically loaded
    const mysql = loadDriver('mysql2/promise') as any;
    pool = mysql.createPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      socketPath: config.socket,
      ssl: config.ssl ? {} : undefined,
      connectionLimit: 5,
    });
  }

  const adapter: DatabaseAdapter = {
    engine: 'mysql',

    get connected(): boolean {
      return pool !== null;
    },

    async connect(): Promise<void> {
      ensurePool();
      // Verify connectivity with a lightweight round-trip
      const conn = await pool.getConnection();
      conn.release();
      resetIdleTimer();
    },

    async query(sql: string): Promise<unknown[]> {
      ensurePool();
      resetIdleTimer();

      const conn = await pool.getConnection();
      try {
        // MAX_EXECUTION_TIME is MySQL-specific; MariaDB may not support it
        try {
          await conn.query(`SET SESSION MAX_EXECUTION_TIME = ${timeoutMs}`);
        } catch {
          // Ignore: server doesn't support MAX_EXECUTION_TIME (e.g. MariaDB)
        }
        const [rows] = await conn.query(sql);
        const result = rows as unknown[];
        return result.slice(0, maxRows);
      } finally {
        conn.release();
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
