import { describe, expect, it } from 'vitest';
import { createReadSystem2DbTool } from './read-system2-db.js';

function mockDb(queryResult: unknown[] | Error) {
  return {
    query: (_sql: string) => {
      if (queryResult instanceof Error) throw queryResult;
      return queryResult;
    },
  } as any;
}

describe('read_system2_db tool', () => {
  it('returns rows as JSON', async () => {
    const rows = [
      { id: 1, name: 'Project A' },
      { id: 2, name: 'Project B' },
    ];
    const tool = createReadSystem2DbTool(mockDb(rows));

    const result = await tool.execute('test', { sql: 'SELECT * FROM project' } as any);

    expect(result.content[0].text).toContain('2 row(s)');
    expect(result.content[0].text).toContain('Project A');
    expect((result.details as any).count).toBe(2);
  });

  it('returns message for empty result', async () => {
    const tool = createReadSystem2DbTool(mockDb([]));

    const result = await tool.execute('test', { sql: 'SELECT * FROM project WHERE 1=0' } as any);

    expect(result.content[0].text).toBe('No results found.');
    expect((result.details as any).count).toBe(0);
  });

  it('returns error on SQL failure', async () => {
    const tool = createReadSystem2DbTool(mockDb(new Error('not authorized')));

    const result = await tool.execute('test', { sql: 'DROP TABLE project' } as any);

    expect(result.content[0].text).toContain('Error');
    expect(result.content[0].text).toContain('not authorized');
  });
});
