/**
 * Read System2 DB Tool
 *
 * Allows agents to query System2's app.db (projects, tasks, agents).
 * This is NOT for querying data pipeline databases — use bash for those.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { DatabaseClient } from '../../db/client.js';

export function createReadSystem2DbTool(db: DatabaseClient) {
  const params = Type.Object({
    sql: Type.String({
      description:
        'SQL SELECT query to execute against the System2 app database (~/.system2/app.db). Tables: project, task, agent, task_link, task_comment.',
    }),
  });

  const tool: AgentTool<typeof params> = {
    name: 'read_system2_db',
    label: 'Read System2 DB',
    description:
      'Execute a SQL SELECT query against the System2 app database (~/.system2/app.db) to retrieve projects, tasks, agents, task links, and comments. This tool is only for the System2 management database — not for data pipeline databases (use bash for those).',
    parameters: params,
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      try {
        const results = db.query(params.sql);

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
  return tool;
}
