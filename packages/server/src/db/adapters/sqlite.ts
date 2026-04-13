/**
 * SQLite Adapter (external databases)
 *
 * Opens a user-specified SQLite file in read-only mode using better-sqlite3,
 * which is already a server dependency (no dynamic loading needed).
 * Tears down after 5 minutes of inactivity.
 *
 * Note: query_timeout does not apply here because better-sqlite3 is synchronous.
 */

import type { DatabaseConnectionConfig } from '@dscarabelli/shared';
import Database from 'better-sqlite3';
import type { AdapterFactory, DatabaseAdapter } from '../adapter.js';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export const createAdapter: AdapterFactory = (
  config: DatabaseConnectionConfig
): DatabaseAdapter => {
  let db: Database.Database | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const maxRows = config.max_rows ?? 10_000;

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (db) {
        db.close();
        db = null;
      }
    }, IDLE_TIMEOUT_MS);
  }

  function ensureDb(): Database.Database {
    if (db) return db;

    db = new Database(config.database, { readonly: true });
    db.pragma('busy_timeout = 5000');
    return db;
  }

  const adapter: DatabaseAdapter = {
    engine: 'sqlite',

    get connected(): boolean {
      return db !== null;
    },

    async connect(): Promise<void> {
      ensureDb();
      resetIdleTimer();
    },

    async query(sql: string): Promise<unknown[]> {
      const instance = ensureDb();
      resetIdleTimer();

      const stmt = instance.prepare(sql);
      const rows: unknown[] = [];
      for (const row of stmt.iterate()) {
        rows.push(row);
        if (rows.length >= maxRows) break;
      }
      return rows;
    },

    async disconnect(): Promise<void> {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (db) {
        db.close();
        db = null;
      }
    },
  };

  return adapter;
};
