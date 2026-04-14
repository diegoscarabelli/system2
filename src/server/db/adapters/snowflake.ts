/**
 * Snowflake Adapter
 *
 * Wraps snowflake-sdk (dynamically loaded from ~/.system2/node_modules/)
 * behind the DatabaseAdapter interface. Creates a single connection lazily
 * on first query and tears it down after 5 minutes of inactivity.
 *
 * The snowflake-sdk uses a callback API throughout, so this adapter
 * promisifies connect, execute, and destroy.
 *
 * Credentials come from:
 * - SNOWFLAKE_PASSWORD environment variable (username/password auth)
 * - config.credentials_file (key-pair auth via privateKeyPath)
 * - ~/.snowflake/connections.toml (SDK-native config file)
 */

import type { DatabaseConnectionConfig } from '../../../shared/index.js';
import type { AdapterFactory, DatabaseAdapter } from '../adapter.js';
import { loadDriver } from '../driver-loader.js';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export const createAdapter: AdapterFactory = (
  config: DatabaseConnectionConfig
): DatabaseAdapter => {
  // biome-ignore lint/suspicious/noExplicitAny: snowflake-sdk is dynamically loaded, no static types available
  let connection: any = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const timeoutMs = (config.query_timeout ?? 30) * 1000;
  const maxRows = config.max_rows ?? 10_000;

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (connection) {
        connection.destroy(() => {});
        connection = null;
      }
    }, IDLE_TIMEOUT_MS);
  }

  async function ensureConnection(): Promise<void> {
    if (connection) return;

    // biome-ignore lint/suspicious/noExplicitAny: snowflake-sdk is dynamically loaded
    const snowflake = loadDriver('snowflake-sdk') as any;

    // biome-ignore lint/suspicious/noExplicitAny: config object built dynamically
    const connOpts: any = {
      account: config.account,
      username: config.user,
      database: config.database,
      timeout: timeoutMs,
    };

    if (config.warehouse) connOpts.warehouse = config.warehouse;
    if (config.role) connOpts.role = config.role;
    if (config.schema) connOpts.schema = config.schema;

    // Key-pair auth via credentials_file (path to private key)
    if (config.credentials_file) {
      connOpts.authenticator = 'SNOWFLAKE_JWT';
      connOpts.privateKeyPath = config.credentials_file;
    }

    const conn = snowflake.createConnection(connOpts);
    try {
      await conn.connectAsync();
    } catch (err) {
      conn.destroy(() => {});
      throw err;
    }
    connection = conn;

    // Set server-side query timeout (seconds)
    const timeoutSec = config.query_timeout ?? 30;
    await new Promise<void>((resolve, reject) => {
      connection.execute({
        sqlText: `ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = ${timeoutSec}`,
        complete: (err: unknown) => {
          if (err) reject(err);
          else resolve();
        },
      });
    });
  }

  const adapter: DatabaseAdapter = {
    engine: 'snowflake',

    get connected(): boolean {
      return connection !== null;
    },

    async connect(): Promise<void> {
      await ensureConnection();
      resetIdleTimer();
    },

    async query(sql: string): Promise<unknown[]> {
      await ensureConnection();
      resetIdleTimer();

      return new Promise((resolve, reject) => {
        connection.execute({
          sqlText: sql,
          complete: (err: unknown, _stmt: unknown, rows: unknown[]) => {
            if (err) {
              reject(err);
            } else {
              resolve((rows ?? []).slice(0, maxRows));
            }
          },
        });
      });
    },

    async disconnect(): Promise<void> {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (connection) {
        await new Promise<void>((resolve) => {
          connection.destroy((err: unknown) => {
            if (err) {
              // best-effort cleanup
            }
            connection = null;
            resolve();
          });
        });
      }
    },
  };

  return adapter;
};
