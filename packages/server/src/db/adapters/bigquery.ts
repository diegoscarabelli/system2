/**
 * BigQuery Adapter
 *
 * Wraps @google-cloud/bigquery (dynamically loaded from ~/.system2/node_modules/)
 * behind the DatabaseAdapter interface. BigQuery is a stateless REST client
 * with no persistent connections, so connect/disconnect are lightweight.
 *
 * Credentials come from (in order):
 * - config.credentials_file (path to service account JSON)
 * - GOOGLE_APPLICATION_CREDENTIALS environment variable
 * - gcloud CLI default credentials
 * - GCE/GKE/Cloud Run metadata server
 *
 * Note: BigQuery queries cost money. The adapter caps result rows via
 * max_rows and enforces jobTimeoutMs, but does not set maximumBytesBilled.
 */

import type { DatabaseConnectionConfig } from '@dscarabelli/shared';
import type { AdapterFactory, DatabaseAdapter } from '../adapter.js';
import { loadDriver } from '../driver-loader.js';

export const createAdapter: AdapterFactory = (
  config: DatabaseConnectionConfig
): DatabaseAdapter => {
  // biome-ignore lint/suspicious/noExplicitAny: @google-cloud/bigquery is dynamically loaded, no static types available
  let client: any = null;

  const timeoutMs = (config.query_timeout ?? 30) * 1000;
  const maxRows = config.max_rows ?? 10_000;

  function ensureClient(): void {
    if (client) return;

    // biome-ignore lint/suspicious/noExplicitAny: @google-cloud/bigquery is dynamically loaded
    const { BigQuery } = loadDriver('@google-cloud/bigquery') as any;

    // biome-ignore lint/suspicious/noExplicitAny: config object built dynamically
    const opts: any = {};
    if (config.project) opts.projectId = config.project;
    if (config.credentials_file) opts.keyFilename = config.credentials_file;

    client = new BigQuery(opts);
  }

  const adapter: DatabaseAdapter = {
    engine: 'bigquery',

    get connected(): boolean {
      return client !== null;
    },

    async connect(): Promise<void> {
      ensureClient();
    },

    async query(sql: string): Promise<unknown[]> {
      ensureClient();

      // biome-ignore lint/suspicious/noExplicitAny: query options built dynamically
      const queryOpts: any = {
        query: sql,
        jobTimeoutMs: timeoutMs,
        useLegacySql: false,
      };

      // Scope queries to the configured dataset if provided
      if (config.database) {
        queryOpts.defaultDataset = { datasetId: config.database };
        if (config.project) {
          queryOpts.defaultDataset.projectId = config.project;
        }
      }

      const [rows] = await client.query(queryOpts);
      return (rows as unknown[]).slice(0, maxRows);
    },

    async disconnect(): Promise<void> {
      // BigQuery is stateless (REST), no connections to close
      client = null;
    },
  };

  return adapter;
};
