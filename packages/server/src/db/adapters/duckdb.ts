/**
 * DuckDB Adapter
 *
 * Wraps the duckdb module (dynamically loaded from ~/.system2/node_modules/)
 * behind the DatabaseAdapter interface. Opens a database file (or :memory:)
 * in read-only mode. Tears down after 5 minutes of inactivity.
 *
 * DuckDB has no native query timeout. We use db.interrupt() with a timer
 * to enforce the configured timeout.
 *
 * MotherDuck connections use the md: prefix in the database path
 * (e.g. database = "md:my_database") and authenticate via the
 * MOTHERDUCK_TOKEN environment variable.
 */

import type { DatabaseConnectionConfig } from '@dscarabelli/shared';
import type { AdapterFactory, DatabaseAdapter } from '../adapter.js';
import { loadDriver } from '../driver-loader.js';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export const createAdapter: AdapterFactory = (
  config: DatabaseConnectionConfig
): DatabaseAdapter => {
  // biome-ignore lint/suspicious/noExplicitAny: duckdb is dynamically loaded, no static types available
  let db: any = null;
  let dbPending: Promise<void> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const timeoutMs = (config.query_timeout ?? 30) * 1000;
  const maxRows = config.max_rows ?? 10_000;
  const isMotherDuck = config.database.startsWith('md:');

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (db) {
        try {
          db.close();
        } catch {
          // best-effort cleanup
        }
        db = null;
      }
    }, IDLE_TIMEOUT_MS);
  }

  function ensureDb(): Promise<void> {
    if (db) return Promise.resolve();
    if (dbPending) return dbPending;

    dbPending = new Promise((resolve, reject) => {
      // biome-ignore lint/suspicious/noExplicitAny: duckdb is dynamically loaded
      const duckdb = loadDriver('duckdb') as any;

      // MotherDuck connections need read-write; local files open read-only
      const flags = isMotherDuck ? duckdb.OPEN_READWRITE : duckdb.OPEN_READONLY;

      const instance = new duckdb.Database(config.database, flags, (err: unknown) => {
        dbPending = null;
        if (err) {
          reject(err);
        } else {
          db = instance;
          resolve();
        }
      });
    });
    return dbPending;
  }

  const adapter: DatabaseAdapter = {
    engine: 'duckdb',

    get connected(): boolean {
      return db !== null;
    },

    async connect(): Promise<void> {
      await ensureDb();
      resetIdleTimer();
    },

    async query(sql: string): Promise<unknown[]> {
      await ensureDb();
      resetIdleTimer();

      return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
          if (!done) {
            try {
              db.interrupt();
            } catch {
              // ignore if interrupt fails
            }
          }
        }, timeoutMs);

        db.all(sql, (err: unknown, rows: unknown[]) => {
          done = true;
          clearTimeout(timer);
          if (err) {
            reject(err);
          } else {
            resolve(rows.slice(0, maxRows));
          }
        });
      });
    },

    async disconnect(): Promise<void> {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (db) {
        await new Promise<void>((resolve) => {
          db.close((err: unknown) => {
            if (err) {
              // best-effort cleanup
            }
            db = null;
            resolve();
          });
        });
      }
    },
  };

  return adapter;
};
