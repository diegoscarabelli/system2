/**
 * Query Database Tool
 *
 * Allows the Guide agent to query System2's app.db.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@mariozechner/pi-ai';
import type { DatabaseClient } from '../../db/client.js';

export function createQueryDatabaseTool(db: DatabaseClient): AgentTool<any> {
  const params = Type.Object({
    sql: Type.String({
      description:
        'SQL query to execute against the app database. Tables: projects, tasks, agents.',
    }),
  });

  return {
    name: 'query_database',
    label: 'Query Database',
    description:
      'Execute a SQL query against the System2 app database to retrieve information about projects, tasks, and agents.',
    parameters: params,
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      try {
        // Execute query
        const results = db.query(params.sql);

        // Format results as text
        const resultText =
          results.length === 0
            ? 'No results found.'
            : `Found ${results.length} row(s):\n\n${JSON.stringify(results, null, 2)}`;

        return {
          content: [{ type: 'text', text: resultText }],
          details: { rows: results, count: results.length },
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error executing query: ${(error as Error).message}`,
            },
          ],
          details: { error: (error as Error).message },
        };
      }
    },
  };
}
