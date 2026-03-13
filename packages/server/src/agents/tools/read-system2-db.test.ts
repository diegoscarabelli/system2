import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../db/client.js';
import { createReadSystem2DbTool } from './read-system2-db.js';

function mockDb(queryResult: unknown[] | Error): DatabaseClient {
  return {
    query: (_sql: string) => {
      if (queryResult instanceof Error) throw queryResult;
      return queryResult;
    },
  } as unknown as DatabaseClient;
}

// Derive types from the tool so tests stay in sync with implementation
const _refTool = createReadSystem2DbTool(mockDb([]));
type DbResult = Awaited<ReturnType<typeof _refTool.execute>>;
type DbParams = Parameters<typeof _refTool.execute>[1];

describe('read_system2_db tool', () => {
  it('returns rows as JSON', async () => {
    const rows = [
      { id: 1, name: 'Project A' },
      { id: 2, name: 'Project B' },
    ];
    const tool = createReadSystem2DbTool(mockDb(rows));

    const result: DbResult = await tool.execute('test', {
      sql: 'SELECT * FROM project',
    } as DbParams);

    expect((result.content[0] as { text: string }).text).toContain('2 row(s)');
    expect((result.content[0] as { text: string }).text).toContain('Project A');
    expect((result.details as { count: number }).count).toBe(2);
  });

  it('returns message for empty result', async () => {
    const tool = createReadSystem2DbTool(mockDb([]));

    const result: DbResult = await tool.execute('test', {
      sql: 'SELECT * FROM project WHERE 1=0',
    } as DbParams);

    expect((result.content[0] as { text: string }).text).toBe('No results found.');
    expect((result.details as { count: number }).count).toBe(0);
  });

  it('returns error on SQL failure', async () => {
    const tool = createReadSystem2DbTool(mockDb(new Error('not authorized')));

    const result: DbResult = await tool.execute('test', { sql: 'DROP TABLE project' } as DbParams);

    expect((result.content[0] as { text: string }).text).toContain('Error');
    expect((result.content[0] as { text: string }).text).toContain('not authorized');
  });
});
