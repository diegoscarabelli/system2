/**
 * Read System2 DB Tool
 *
 * Allows agents to query System2's app.db (projects, tasks, agents).
 * This is NOT for querying data pipeline databases — use bash for those.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { type Static, Type } from '@sinclair/typebox';
import type { DatabaseClient } from '../../db/client.js';

export function createReadSystem2DbTool(db: DatabaseClient) {
  const readSystem2DbParams = Type.Object({
    sql: Type.String({
      description:
        'SQL SELECT query to execute against the System2 app database (~/.system2/app.db). Tables: project, task, agent, task_link, task_comment.',
    }),
  });

  const tool: AgentTool<typeof readSystem2DbParams> = {
    name: 'read_system2_db',
    label: 'Read System2 DB',
    description:
      'Execute a SQL SELECT query against the System2 app database (~/.system2/app.db) to retrieve projects, tasks, agents, task links, and comments. This tool is only for the System2 management database — not for data pipeline databases (use bash for those).',
    parameters: readSystem2DbParams,
    execute: async (_toolCallId, rawParams, _signal, _onUpdate) => {
      // pi-agent-core 0.71 (typebox-1) types execute params loosely (each
      // schema field as possibly undefined). Required fields are validated
      // before execute is called, so narrow once via the schema's Static type.
      const params = rawParams as Static<typeof readSystem2DbParams>;
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
