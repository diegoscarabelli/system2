/**
 * ClickHouse Adapter
 *
 * Wraps @clickhouse/client (dynamically loaded from ~/.system2/node_modules/)
 * behind the DatabaseAdapter interface. Uses HTTP protocol (port 8123 default).
 * Tears down client after 5 minutes of inactivity.
 */

import type { DatabaseConnectionConfig } from '@dscarabelli/shared';
import type { AdapterFactory, DatabaseAdapter } from '../adapter.js';
import { loadDriver } from '../driver-loader.js';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export const createAdapter: AdapterFactory = (
  config: DatabaseConnectionConfig
): DatabaseAdapter => {
  // biome-ignore lint/suspicious/noExplicitAny: @clickhouse/client is dynamically loaded, no static types available
  let client: any = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const timeoutMs = (config.query_timeout ?? 30) * 1000;
  const maxRows = config.max_rows ?? 10_000;

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (client) {
        client.close().catch(() => {});
        client = null;
      }
    }, IDLE_TIMEOUT_MS);
  }

  function ensureClient(): void {
    if (client) return;

    // biome-ignore lint/suspicious/noExplicitAny: @clickhouse/client is dynamically loaded
    const { createClient } = loadDriver('@clickhouse/client') as any;
    const protocol = config.ssl ? 'https' : 'http';
    const host = config.host ?? 'localhost';
    const port = config.port ?? 8123;

    client = createClient({
      url: `${protocol}://${host}:${port}`,
      database: config.database,
      username: config.user ?? 'default',
      request_timeout: timeoutMs,
      clickhouse_settings: {
        max_execution_time: config.query_timeout ?? 30,
      },
    });
  }

  const adapter: DatabaseAdapter = {
    engine: 'clickhouse',

    get connected(): boolean {
      return client !== null;
    },

    async connect(): Promise<void> {
      ensureClient();
      try {
        const result = await client.ping();
        if (!result.success) {
          throw result.error ?? new Error('ClickHouse ping failed');
        }
      } catch (err) {
        await client.close().catch(() => {});
        client = null;
        throw err;
      }
      resetIdleTimer();
    },

    async query(sql: string): Promise<unknown[]> {
      ensureClient();
      resetIdleTimer();

      const resultSet = await client.query({
        query: sql,
        format: 'JSONEachRow',
      });
      const rows = (await resultSet.json()) as unknown[];
      return rows.slice(0, maxRows);
    },

    async disconnect(): Promise<void> {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (client) {
        await client.close();
        client = null;
      }
    },
  };

  return adapter;
};
