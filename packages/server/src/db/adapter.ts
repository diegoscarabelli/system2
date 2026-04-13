/**
 * Database Adapter Interface
 *
 * Uniform async interface for querying databases through the postMessage bridge.
 * Each adapter wraps a specific database driver (pg, mysql2, better-sqlite3,
 * mssql, @clickhouse/client, duckdb, snowflake-sdk, @google-cloud/bigquery).
 */

import type { DatabaseConnectionConfig } from '@dscarabelli/shared';

export interface DatabaseAdapter {
  readonly engine: string;
  readonly connected: boolean;
  connect(): Promise<void>;
  query(sql: string): Promise<unknown[]>;
  disconnect(): Promise<void>;
}

export type AdapterFactory = (config: DatabaseConnectionConfig) => DatabaseAdapter;
