/**
 * MSSQL / SQL Server Adapter
 *
 * Wraps the mssql module (dynamically loaded from ~/.system2/node_modules/)
 * behind the DatabaseAdapter interface. Creates a ConnectionPool lazily on
 * first query and tears it down after 5 minutes of inactivity.
 *
 * Credentials must be passed via environment variables (MSSQL_USER, MSSQL_PASSWORD)
 * or Azure AD authentication. The mssql package has no native credential file.
 */

import type { DatabaseConnectionConfig } from '../../../shared/index.js';
import type { AdapterFactory, DatabaseAdapter } from '../adapter.js';
import { loadDriver } from '../driver-loader.js';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export const createAdapter: AdapterFactory = (
  config: DatabaseConnectionConfig
): DatabaseAdapter => {
  // biome-ignore lint/suspicious/noExplicitAny: mssql is dynamically loaded, no static types available
  let pool: any = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const timeoutMs = (config.query_timeout ?? 30) * 1000;
  const maxRows = config.max_rows ?? 10_000;

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (pool) {
        pool.close().catch(() => {});
        pool = null;
      }
    }, IDLE_TIMEOUT_MS);
  }

  async function ensurePool(): Promise<void> {
    if (pool) return;

    // biome-ignore lint/suspicious/noExplicitAny: mssql is dynamically loaded
    const mssql = loadDriver('mssql') as any;
    const newPool = new mssql.ConnectionPool({
      server: config.host ?? 'localhost',
      port: config.port ?? 1433,
      database: config.database,
      user: config.user,
      options: {
        encrypt: config.ssl ?? false,
        trustServerCertificate: !config.ssl,
      },
      requestTimeout: timeoutMs,
      pool: { max: 5 },
    });
    await newPool.connect();
    pool = newPool;
  }

  const adapter: DatabaseAdapter = {
    engine: 'mssql',

    get connected(): boolean {
      return pool !== null;
    },

    async connect(): Promise<void> {
      await ensurePool();
      resetIdleTimer();
    },

    async query(sql: string): Promise<unknown[]> {
      await ensurePool();
      resetIdleTimer();

      const result = await pool.request().query(sql);
      const rows = result.recordset as unknown[];
      return rows.slice(0, maxRows);
    },

    async disconnect(): Promise<void> {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (pool) {
        await pool.close();
        pool = null;
      }
    },
  };

  return adapter;
};
