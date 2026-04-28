import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgentHost, MAX_DELIVERY_BYTES } from '../agents/host.js';
import type { DatabaseClient } from '../db/client.js';
import { log } from '../utils/logger.js';
import {
  buildAndDeliverDailySummary,
  buildAndDeliverMemoryUpdate,
  collectAgentActivity,
  collectAgentActivityWithTimestamps,
  type DbChangeTable,
  formatMarkdownTable,
  JobSkipped,
  NARRATOR_MESSAGE_EXCERPT_BYTES,
  readFrontmatterField,
  readTailChars,
  registerNarratorJobs,
  renderAgentActivitySections,
  resolveDailySummaryTimestamp,
  stripSessionEntry,
  trackJobExecution,
  truncateDbChangesToFit,
  truncateOldestToFit,
  writeFrontmatterField,
} from './jobs.js';
import type { Scheduler } from './scheduler.js';

vi.mock('./network.js', () => ({
  isNetworkAvailable: vi.fn(),
}));

import { isNetworkAvailable } from './network.js';

const mockIsNetworkAvailable = vi.mocked(isNetworkAvailable);

function makeTmpDir(): string {
  const dir = join(tmpdir(), `system2-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tmpDirs: string[] = [];
function trackTmpDir(dir: string): string {
  tmpDirs.push(dir);
  return dir;
}

function mockNarratorHost(): AgentHost & { calls: Array<{ content: string; details: unknown }> } {
  const calls: Array<{ content: string; details: unknown }> = [];
  return {
    calls,
    deliverMessage(content: string, details: unknown) {
      calls.push({ content, details });
      return Promise.resolve();
    },
  } as unknown as AgentHost & { calls: Array<{ content: string; details: unknown }> };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
  mockIsNetworkAvailable.mockReset();
});

describe('readFrontmatterField', () => {
  it('reads a field from YAML frontmatter', () => {
    const dir = trackTmpDir(makeTmpDir());
    const file = join(dir, 'test.md');
    writeFileSync(file, '---\ntitle: Hello World\ndate: 2025-01-01\n---\nBody');
    expect(readFrontmatterField(file, 'title')).toBe('Hello World');
    expect(readFrontmatterField(file, 'date')).toBe('2025-01-01');
  });

  it('returns null for missing field', () => {
    const dir = trackTmpDir(makeTmpDir());
    const file = join(dir, 'test.md');
    writeFileSync(file, '---\ntitle: Test\n---\n');
    expect(readFrontmatterField(file, 'missing')).toBeNull();
  });

  it('returns null for missing file', () => {
    expect(readFrontmatterField('/nonexistent/file.md', 'title')).toBeNull();
  });

  it('returns null for empty field value', () => {
    const dir = trackTmpDir(makeTmpDir());
    const file = join(dir, 'test.md');
    writeFileSync(file, '---\nlast_narrator_update_ts:\n---\n');
    expect(readFrontmatterField(file, 'last_narrator_update_ts')).toBeNull();
  });
});

describe('writeFrontmatterField', () => {
  it('replaces an existing field value', () => {
    const dir = trackTmpDir(makeTmpDir());
    const file = join(dir, 'test.md');
    writeFileSync(file, '---\nlast_narrator_update_ts: old-value\n---\n# Body');
    writeFrontmatterField(file, 'last_narrator_update_ts', '2026-03-30T00:00:00Z');
    expect(readFrontmatterField(file, 'last_narrator_update_ts')).toBe('2026-03-30T00:00:00Z');
    expect(readFileSync(file, 'utf-8')).toContain('# Body');
  });

  it('replaces an empty field value', () => {
    const dir = trackTmpDir(makeTmpDir());
    const file = join(dir, 'test.md');
    writeFileSync(file, '---\nlast_narrator_update_ts:\n---\n');
    writeFrontmatterField(file, 'last_narrator_update_ts', '2026-03-30T00:00:00Z');
    expect(readFrontmatterField(file, 'last_narrator_update_ts')).toBe('2026-03-30T00:00:00Z');
  });

  it('inserts field if not found in frontmatter', () => {
    const dir = trackTmpDir(makeTmpDir());
    const file = join(dir, 'test.md');
    writeFileSync(file, '---\ntitle: Test\n---\n# Body');
    writeFrontmatterField(file, 'last_narrator_update_ts', '2026-03-30T00:00:00Z');
    expect(readFrontmatterField(file, 'last_narrator_update_ts')).toBe('2026-03-30T00:00:00Z');
    expect(readFileSync(file, 'utf-8')).toContain('title: Test');
  });

  it('no-ops on missing file', () => {
    writeFrontmatterField('/nonexistent/file.md', 'field', 'value');
    // No throw
  });

  it('no-ops on file without frontmatter', () => {
    const dir = trackTmpDir(makeTmpDir());
    const file = join(dir, 'test.md');
    writeFileSync(file, '# No frontmatter');
    writeFrontmatterField(file, 'field', 'value');
    expect(readFileSync(file, 'utf-8')).toBe('# No frontmatter');
  });
});

describe('readTailChars', () => {
  it('reads last N characters of a file', () => {
    const dir = trackTmpDir(makeTmpDir());
    const file = join(dir, 'log.txt');
    writeFileSync(file, 'abcdefghij'); // 10 chars
    expect(readTailChars(file, 5)).toBe('fghij');
  });

  it('returns full content if file has fewer than N chars', () => {
    const dir = trackTmpDir(makeTmpDir());
    const file = join(dir, 'log.txt');
    writeFileSync(file, 'short');
    expect(readTailChars(file, 100)).toBe('short');
  });

  it('returns empty string for missing file', () => {
    expect(readTailChars('/nonexistent/file.txt', 5)).toBe('');
  });

  it('returns exact content when length equals N', () => {
    const dir = trackTmpDir(makeTmpDir());
    const file = join(dir, 'log.txt');
    writeFileSync(file, 'exact');
    expect(readTailChars(file, 5)).toBe('exact');
  });
});

describe('formatMarkdownTable', () => {
  it('formats rows as a markdown table', () => {
    const rows = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ];
    const result = formatMarkdownTable(rows);
    expect(result).toContain('| id | name |');
    expect(result).toContain('|---|---|');
    expect(result).toContain('| 1 | Alice |');
    expect(result).toContain('| 2 | Bob |');
  });

  it('returns "(no data)" for empty array', () => {
    expect(formatMarkdownTable([])).toBe('(no data)');
  });

  it('handles null/undefined values', () => {
    const rows = [{ a: null, b: undefined }];
    const result = formatMarkdownTable(rows);
    expect(result).toContain('|  |  |');
  });
});

describe('resolveDailySummaryTimestamp', () => {
  it('returns null lastRunTs on first run with no files', () => {
    const dir = trackTmpDir(makeTmpDir());
    const result = resolveDailySummaryTimestamp(dir, 30);
    expect(result.lastRunTs).toBeNull();
    expect(result.newRunTs).toBeTruthy();
    expect(result.filePath).toContain('daily_summaries');
  });

  it('picks up timestamp from existing daily summary', () => {
    const dir = trackTmpDir(makeTmpDir());
    const summariesDir = join(dir, 'knowledge', 'daily_summaries');
    mkdirSync(summariesDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(
      join(summariesDir, `${today}.md`),
      '---\nlast_narrator_update_ts: 2025-06-01T10:00:00Z\n---\n# Summary'
    );
    const result = resolveDailySummaryTimestamp(dir, 30);
    expect(result.lastRunTs).toBe('2025-06-01T10:00:00Z');
  });
});

describe('collectAgentActivity', () => {
  it('reports "(no activity)" for agents without session dirs', () => {
    const dir = trackTmpDir(makeTmpDir());
    const agents = [{ id: 1, role: 'guide', project_name: 'test-project' }];
    const result = collectAgentActivity(
      dir,
      agents,
      '2025-01-01T00:00:00Z',
      '2025-12-31T23:59:59Z'
    );
    expect(result).toContain('(no activity)');
    expect(result).toContain('guide_1');
    expect(result).toContain('project: test-project');
  });

  it('collects entries in the time window', () => {
    const dir = trackTmpDir(makeTmpDir());
    const sessionDir = join(dir, 'sessions', 'guide_1');
    mkdirSync(sessionDir, { recursive: true });

    const entries = [
      JSON.stringify({ type: 'message', timestamp: '2025-06-01T09:00:00Z', content: 'before' }),
      JSON.stringify({ type: 'message', timestamp: '2025-06-01T10:30:00Z', content: 'in-window' }),
      JSON.stringify({ type: 'message', timestamp: '2025-06-01T12:00:00Z', content: 'after' }),
      JSON.stringify({
        type: 'session',
        timestamp: '2025-06-01T10:30:00Z',
        content: 'excluded-type',
      }),
    ];
    writeFileSync(join(sessionDir, 'session.jsonl'), entries.join('\n'));

    const agents = [{ id: 1, role: 'guide', project_name: null }];
    const result = collectAgentActivity(
      dir,
      agents,
      '2025-06-01T10:00:00Z',
      '2025-06-01T11:00:00Z'
    );
    expect(result).toContain('in-window');
    expect(result).not.toContain('before');
    expect(result).not.toContain('after');
    expect(result).not.toContain('excluded-type');
  });
});

describe('truncateOldestToFit', () => {
  it('returns empty result for empty input', () => {
    const result = truncateOldestToFit([], 1024);
    expect(result.kept).toEqual([]);
    expect(result.droppedCount).toBe(0);
    expect(result.droppedRange).toBeNull();
  });

  it('keeps all entries when total is under budget', () => {
    const entries = [
      { timestamp: '2026-01-01T01:00:00Z', rendered: 'a'.repeat(100) },
      { timestamp: '2026-01-01T02:00:00Z', rendered: 'b'.repeat(100) },
    ];
    const result = truncateOldestToFit(entries, 500);
    expect(result.droppedCount).toBe(0);
    expect(result.droppedRange).toBeNull();
    expect(result.kept).toHaveLength(2);
    // Returned in sorted order
    expect(result.kept[0].timestamp).toBe('2026-01-01T01:00:00Z');
  });

  it('drops oldest entries first when total exceeds budget', () => {
    const entries = [
      { timestamp: '2026-01-01T03:00:00Z', rendered: 'c'.repeat(200) },
      { timestamp: '2026-01-01T01:00:00Z', rendered: 'a'.repeat(200) }, // oldest
      { timestamp: '2026-01-01T02:00:00Z', rendered: 'b'.repeat(200) },
    ];
    // Budget of 350 means the two oldest (400 total) must be trimmed to fit
    const result = truncateOldestToFit(entries, 350);
    expect(result.droppedCount).toBeGreaterThan(0);
    // Total rendered size of kept entries must fit within budget
    const keptSize = result.kept.reduce((s, e) => s + e.rendered.length, 0);
    expect(keptSize).toBeLessThanOrEqual(350);
    // The newest entry should survive
    const keptTimestamps = result.kept.map((e) => e.timestamp);
    expect(keptTimestamps).toContain('2026-01-01T03:00:00Z');
    // The dropped range starts at the oldest
    expect(result.droppedRange?.from).toBe('2026-01-01T01:00:00Z');
  });

  it('handles a single entry that exceeds the budget on its own', () => {
    const entries = [{ timestamp: '2026-01-01T01:00:00Z', rendered: 'x'.repeat(1000) }];
    const result = truncateOldestToFit(entries, 500);
    expect(result.kept).toEqual([]);
    expect(result.droppedCount).toBe(1);
    expect(result.droppedRange?.from).toBe('2026-01-01T01:00:00Z');
    expect(result.droppedRange?.to).toBe('2026-01-01T01:00:00Z');
  });
});

describe('truncateDbChangesToFit', () => {
  function makeTable(
    name: string,
    timeColumn: string,
    rows: Record<string, unknown>[]
  ): DbChangeTable {
    return { name, sql: `SELECT * FROM ${name}`, rows, timeColumn };
  }

  it('returns empty result for empty input', () => {
    const result = truncateDbChangesToFit([], 1024);
    expect(result.rendered).toBe('');
    expect(result.droppedTotal).toBe(0);
    expect(result.droppedRanges).toEqual([]);
  });

  it('keeps all rows when total is under budget', () => {
    const rows = [
      { id: 1, updated_at: '2026-01-01T10:00:00Z', title: 'Task A' },
      { id: 2, updated_at: '2026-01-01T11:00:00Z', title: 'Task B' },
    ];
    const result = truncateDbChangesToFit([makeTable('task', 'updated_at', rows)], 100_000);
    expect(result.droppedTotal).toBe(0);
    expect(result.droppedRanges).toEqual([]);
    expect(result.rendered).toContain('Task A');
    expect(result.rendered).toContain('Task B');
    expect(result.rendered).not.toContain('[NOTE: dropped');
  });

  it('keeps newest rows and drops oldest when over budget', () => {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      rows.push({
        id: i,
        updated_at: `2026-01-01T${String(i).padStart(2, '0')}:00:00Z`,
        payload: 'x'.repeat(200),
      });
    }
    // Budget tight enough to force truncation: each row is ~220 bytes
    const result = truncateDbChangesToFit([makeTable('task', 'updated_at', rows)], 2_000);
    expect(result.droppedTotal).toBeGreaterThan(0);
    expect(result.droppedRanges).toHaveLength(1);
    expect(result.droppedRanges[0].table).toBe('task');
    // Annotation is present in the rendered output
    expect(result.rendered).toContain('[NOTE: dropped');
    expect(result.rendered).toContain('oldest DB-change rows from task');
    // Only newest rows kept (highest timestamps survive)
    expect(result.rendered).toContain('2026-01-01T49:00:00Z');
    // Oldest row id 0 must not appear as a table row (it may appear in the annotation range)
    const tableRows = result.rendered
      .split('\n')
      .filter((l) => l.startsWith('|') && !l.startsWith('| id') && !l.startsWith('|---'));
    const rowIds = tableRows.map((l) => Number(l.split('|')[1].trim()));
    expect(rowIds).not.toContain(0); // id=0 is the oldest row, should be dropped
  });

  it('handles multiple tables, splitting budget evenly', () => {
    const taskRows: Record<string, unknown>[] = [];
    const commentRows: Record<string, unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      taskRows.push({
        id: i,
        updated_at: `2026-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
        payload: 'a'.repeat(200),
      });
      commentRows.push({
        id: i + 100,
        created_at: `2026-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
        payload: 'b'.repeat(200),
      });
    }
    const tables = [
      makeTable('task', 'updated_at', taskRows),
      makeTable('task_comment', 'created_at', commentRows),
    ];
    // Very tight budget to force truncation in both tables
    const result = truncateDbChangesToFit(tables, 2_000);
    expect(result.rendered).toContain('### task');
    expect(result.rendered).toContain('### task_comment');
    // Both tables were independently truncated
    expect(result.droppedTotal).toBeGreaterThan(0);
  });

  it('integration: large project DB changes fit within MAX_DELIVERY_BYTES', async () => {
    // Simulate 2000 task updates (~200 bytes each = ~400 KB raw)
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 2000; i++) {
      rows.push({
        id: i,
        project: 1,
        title: `Task ${i}`,
        status: 'done',
        updated_at: `2026-01-01T${String(Math.floor(i / 100)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
        description: 'y'.repeat(100),
      });
    }

    const CATCH_UP_BUDGET = 512 * 1024;
    const DB_BUDGET = Math.floor(CATCH_UP_BUDGET * 0.25); // 25%
    const result = truncateDbChangesToFit([makeTable('task', 'updated_at', rows)], DB_BUDGET);

    // The rendered DB section must fit within the DB budget
    expect(Buffer.byteLength(result.rendered, 'utf8')).toBeLessThanOrEqual(
      DB_BUDGET + 500 // allow small annotation overhead
    );
    expect(result.droppedTotal).toBeGreaterThan(0);
    expect(result.rendered).toContain('[NOTE: dropped');
  });
});

describe('collectAgentActivityWithTimestamps', () => {
  it('returns empty array for agents without session dirs', () => {
    const dir = trackTmpDir(makeTmpDir());
    const agents = [{ id: 1, role: 'guide', project_name: null }];
    const result = collectAgentActivityWithTimestamps(
      dir,
      agents,
      '2025-01-01T00:00:00Z',
      '2025-12-31T23:59:59Z'
    );
    expect(result).toEqual([]);
  });

  it('returns TimestampedEntry objects for in-window entries', () => {
    const dir = trackTmpDir(makeTmpDir());
    const sessionDir = join(dir, 'sessions', 'guide_1');
    mkdirSync(sessionDir, { recursive: true });

    const entryTs = '2025-06-01T10:30:00Z';
    const entry = JSON.stringify({
      type: 'message',
      timestamp: entryTs,
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
    writeFileSync(join(sessionDir, 'session.jsonl'), entry);

    const agents = [{ id: 1, role: 'guide', project_name: null }];
    const result = collectAgentActivityWithTimestamps(
      dir,
      agents,
      '2025-06-01T10:00:00Z',
      '2025-06-01T11:00:00Z'
    );
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe(entryTs);
    expect(typeof result[0].rendered).toBe('string');
    // rendered is a JSON string of the stripped entry
    const parsed = JSON.parse(result[0].rendered);
    expect(parsed.timestamp).toBe(entryTs);
  });
});

describe('renderAgentActivitySections', () => {
  it('renders (no activity) when entries array is empty', () => {
    const dir = trackTmpDir(makeTmpDir());
    const sessionDir = join(dir, 'sessions', 'guide_1');
    mkdirSync(sessionDir, { recursive: true });

    // Write an entry so the session dir exists but pass an empty kept array
    const entryTs = '2025-06-01T10:30:00Z';
    writeFileSync(
      join(sessionDir, 'session.jsonl'),
      JSON.stringify({
        type: 'message',
        timestamp: entryTs,
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      })
    );

    const agents = [{ id: 1, role: 'guide', project_name: null }];
    const result = renderAgentActivitySections(
      dir,
      agents,
      '2025-06-01T10:00:00Z',
      '2025-06-01T11:00:00Z',
      [] // empty kept set
    );
    expect(result).toContain('(no activity)');
  });

  it('renders only the kept entries when a subset is passed', () => {
    const dir = trackTmpDir(makeTmpDir());
    const sessionDir = join(dir, 'sessions', 'guide_1');
    mkdirSync(sessionDir, { recursive: true });

    const ts1 = '2025-06-01T10:00:00Z';
    const ts2 = '2025-06-01T10:30:00Z';
    const e1 = {
      type: 'message',
      timestamp: ts1,
      message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
    };
    const e2 = {
      type: 'message',
      timestamp: ts2,
      message: { role: 'user', content: [{ type: 'text', text: 'second' }] },
    };
    writeFileSync(
      join(sessionDir, 'session.jsonl'),
      [JSON.stringify(e1), JSON.stringify(e2)].join('\n')
    );

    const agents = [{ id: 1, role: 'guide', project_name: null }];
    // Only pass the second entry as "kept"
    const kept = [{ timestamp: ts2, rendered: JSON.stringify({ ...e2 }) }];
    const result = renderAgentActivitySections(
      dir,
      agents,
      '2025-06-01T09:00:00Z',
      '2025-06-01T11:00:00Z',
      kept
    );
    expect(result).toContain(ts2);
    expect(result).not.toContain(ts1);
  });
});

describe('buildAndDeliverMemoryUpdate', () => {
  it('throws JobSkipped when no daily summary files exist', async () => {
    const dir = trackTmpDir(makeTmpDir());
    const knowledgeDir = join(dir, 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    writeFileSync(
      join(knowledgeDir, 'memory.md'),
      '---\nlast_narrator_update_ts: 2026-03-10T00:00:00Z\n---\n# Memory'
    );

    const host = mockNarratorHost();
    await expect(buildAndDeliverMemoryUpdate(host, 2, dir)).rejects.toThrow(JobSkipped);
    expect(host.calls).toHaveLength(0);
  });

  it('throws JobSkipped when all summaries are older than last update', async () => {
    const dir = trackTmpDir(makeTmpDir());
    const knowledgeDir = join(dir, 'knowledge');
    const summariesDir = join(knowledgeDir, 'daily_summaries');
    mkdirSync(summariesDir, { recursive: true });
    writeFileSync(
      join(knowledgeDir, 'memory.md'),
      '---\nlast_narrator_update_ts: 2026-03-12T00:00:00Z\n---\n# Memory'
    );
    writeFileSync(join(summariesDir, '2026-03-10.md'), '---\n---\n# Old summary');

    const host = mockNarratorHost();
    await expect(buildAndDeliverMemoryUpdate(host, 2, dir)).rejects.toThrow(JobSkipped);
    expect(host.calls).toHaveLength(0);
  });

  it('delivers message with embedded summary content since last update', async () => {
    const dir = trackTmpDir(makeTmpDir());
    const knowledgeDir = join(dir, 'knowledge');
    const summariesDir = join(knowledgeDir, 'daily_summaries');
    mkdirSync(summariesDir, { recursive: true });
    writeFileSync(
      join(knowledgeDir, 'memory.md'),
      '---\nlast_narrator_update_ts: 2026-03-10T00:00:00Z\n---\n# Memory'
    );
    writeFileSync(
      join(summariesDir, '2026-03-10.md'),
      '---\n---\n# Summary 10\nDay ten narrative.'
    );
    writeFileSync(
      join(summariesDir, '2026-03-11.md'),
      '---\n---\n# Summary 11\nDay eleven narrative.'
    );
    writeFileSync(join(summariesDir, '2026-03-09.md'), '---\n---\n# Before\nOld narrative.');

    const host = mockNarratorHost();
    await buildAndDeliverMemoryUpdate(host, 2, dir);
    expect(host.calls).toHaveLength(1);

    const msg = host.calls[0].content;
    expect(msg).toContain('[Scheduled task: memory-update]');
    // Content is embedded inline (not just file paths)
    expect(msg).toContain('Day ten narrative.');
    expect(msg).toContain('Day eleven narrative.');
    // Older summary excluded entirely
    expect(msg).not.toContain('Old narrative.');
    expect(msg).not.toContain('2026-03-09.md');
    expect(msg).toContain('IMPORTANT');
  });

  it('includes all summaries when memory.md has no timestamp', async () => {
    const dir = trackTmpDir(makeTmpDir());
    const knowledgeDir = join(dir, 'knowledge');
    const summariesDir = join(knowledgeDir, 'daily_summaries');
    mkdirSync(summariesDir, { recursive: true });
    writeFileSync(join(knowledgeDir, 'memory.md'), '---\nlast_narrator_update_ts:\n---\n# Memory');
    writeFileSync(join(summariesDir, '2026-03-10.md'), '---\n---\n# Summary\nNarrative content.');

    const host = mockNarratorHost();
    await buildAndDeliverMemoryUpdate(host, 2, dir);
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0].content).toContain('Narrative content.');
  });

  it('delivers condensation message when knowledge file exceeds budget with no summaries', async () => {
    const dir = trackTmpDir(makeTmpDir());
    const knowledgeDir = join(dir, 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    writeFileSync(
      join(knowledgeDir, 'memory.md'),
      '---\nlast_narrator_update_ts: 2026-03-10T00:00:00Z\n---\n# Memory'
    );
    // Write an oversized infrastructure.md (>20,000 chars)
    writeFileSync(
      join(knowledgeDir, 'infrastructure.md'),
      `# Infrastructure\n\n${'x'.repeat(21_000)}`
    );

    const host = mockNarratorHost();
    await buildAndDeliverMemoryUpdate(host, 2, dir);
    expect(host.calls).toHaveLength(1);

    const msg = host.calls[0].content;
    expect(msg).toContain('[Scheduled task: memory-update]');
    expect(msg).toContain('## Knowledge Files Requiring Condensation');
    expect(msg).toContain('infrastructure.md');
    expect(msg).not.toContain('## Daily summaries to incorporate');
  });
});

describe('stripSessionEntry', () => {
  it('passes through unknown entry types unchanged', () => {
    const entry = { type: 'session', version: 3, id: 'abc' };
    expect(stripSessionEntry(entry)).toEqual(entry);
  });

  it('passes through message with user role unchanged', () => {
    const entry = {
      type: 'message',
      timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    };
    expect(stripSessionEntry(entry)).toEqual(entry);
  });

  it('passes through message with missing message field unchanged', () => {
    const entry = { type: 'message', timestamp: '2026-01-01T00:00:00Z' };
    expect(stripSessionEntry(entry)).toEqual(entry);
  });

  describe('custom_message', () => {
    it('drops details', () => {
      const entry = {
        type: 'custom_message',
        content: 'hello',
        details: { sender: 1, receiver: 2, timestamp: 0 },
      };
      const result = stripSessionEntry(entry);
      expect(result).not.toHaveProperty('details');
      expect(result.content).toBe('hello');
    });

    it('does not crash when details is absent', () => {
      const entry = { type: 'custom_message', content: 'hello' };
      expect(stripSessionEntry(entry)).toEqual({ type: 'custom_message', content: 'hello' });
    });

    it('truncates content exceeding NARRATOR_MESSAGE_EXCERPT_BYTES', () => {
      const longContent = 'x'.repeat(20 * 1024); // 20 KB, exceeds 16 KB budget
      const entry = {
        type: 'custom_message',
        content: longContent,
        details: { sender: 1, receiver: 2, timestamp: 0 },
      };
      const result = stripSessionEntry(entry) as Record<string, unknown>;
      expect(result).not.toHaveProperty('details');
      expect(typeof result.content).toBe('string');
      const contentStr = result.content as string;
      expect(contentStr.length).toBeLessThanOrEqual(NARRATOR_MESSAGE_EXCERPT_BYTES + 100); // budget + truncation marker
      expect(contentStr).toContain(
        `[...truncated: narrator message excerpt exceeded ${NARRATOR_MESSAGE_EXCERPT_BYTES}-byte budget]`
      );
    });

    it('respects byte budget with multi-byte UTF-8 content (regression test)', () => {
      // Create content with 4-byte UTF-8 emoji characters
      // Each emoji is 4 bytes in UTF-8
      const emoji = '🔥'; // 4 bytes in UTF-8
      // Budget is 16KB (16384 bytes), so we need > 4096 emojis to exceed it
      const emojisNeeded = 5000; // 20000 bytes total, exceeds 16KB budget
      const multiByteContent = emoji.repeat(emojisNeeded);

      const entry = {
        type: 'custom_message',
        content: multiByteContent,
        details: { sender: 1, receiver: 2, timestamp: 0 },
      };
      const result = stripSessionEntry(entry) as Record<string, unknown>;
      const contentStr = result.content as string;

      // Verify the truncation marker is present
      expect(contentStr).toContain('[...truncated: narrator message excerpt exceeded');

      // Verify byte length is within budget (excludes the truncation marker)
      const truncatedPart = contentStr.split('\n\n[...truncated:')[0];
      const byteLength = Buffer.byteLength(truncatedPart, 'utf8');
      expect(byteLength).toBeLessThanOrEqual(NARRATOR_MESSAGE_EXCERPT_BYTES);
    });
  });

  describe('assistant message', () => {
    it('drops usage, api, provider, model', () => {
      const entry = {
        type: 'message',
        message: {
          role: 'assistant',
          api: 'google-generative-ai',
          provider: 'google',
          model: 'gemini-2.0-flash',
          usage: { input: 1000, output: 50, totalTokens: 1050 },
          content: [],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      expect(result.message).not.toHaveProperty('api');
      expect(result.message).not.toHaveProperty('provider');
      expect(result.message).not.toHaveProperty('model');
      expect(result.message).not.toHaveProperty('usage');
    });

    it('drops thoughtSignature but preserves id in toolCall blocks', () => {
      const entry = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call-123',
              name: 'bash',
              thoughtSignature: 'a'.repeat(500),
              arguments: { command: 'echo hi' },
            },
          ],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      expect(block).not.toHaveProperty('thoughtSignature');
      expect(block.id).toBe('call-123');
      expect(block.name).toBe('bash');
    });

    it('truncates long string argument values to 100 chars', () => {
      const longCmd = 'x'.repeat(300);
      const entry = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'bash', arguments: { command: longCmd } }],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      const args = block.arguments as Record<string, unknown>;
      expect(typeof args.command).toBe('string');
      expect((args.command as string).length).toBe(100);
    });

    it('does not truncate argument values already under 100 chars', () => {
      const entry = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'echo hi' } }],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      const args = block.arguments as Record<string, unknown>;
      expect(args.command).toBe('echo hi');
    });

    it('passes non-string argument values through unchanged', () => {
      const entry = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', name: 'read_system2_db', arguments: { limit: 10, dry: true } },
          ],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      const args = block.arguments as Record<string, unknown>;
      expect(args.limit).toBe(10);
      expect(args.dry).toBe(true);
    });

    it('truncates string-form arguments to 100 chars', () => {
      const longJson = 'x'.repeat(300);
      const entry = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'bash', arguments: longJson }],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      expect(typeof block.arguments).toBe('string');
      expect((block.arguments as string).length).toBe(100);
    });

    it('preserves array arguments as-is', () => {
      const entry = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'bash', arguments: ['arg1', 'arg2'] }],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      expect(Array.isArray(block.arguments)).toBe(true);
      expect(block.arguments).toEqual(['arg1', 'arg2']);
    });

    it('does not add arguments key when absent on toolCall', () => {
      const entry = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'bash' }],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      expect(block).not.toHaveProperty('arguments');
    });

    it('drops thinking blocks entirely', () => {
      const thinking = 'deep thought '.repeat(20);
      const entry = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking, thinkingSignature: 'sig' },
            { type: 'text', text: 'Done.' },
          ],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const blocks = result.message.content as Record<string, unknown>[];
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('text');
    });

    it('preserves text blocks, stripping textSignature', () => {
      const entry = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.', textSignature: 'abc123==' }],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      expect(block.text).toBe('Done.');
      expect(block.textSignature).toBeUndefined();
    });

    it('does not crash when content is not an array', () => {
      const entry = {
        type: 'message',
        message: { role: 'assistant', content: null },
      };
      expect(() => stripSessionEntry(entry)).not.toThrow();
    });
  });

  describe('toolResult message', () => {
    it('drops details', () => {
      const entry = {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'bash',
          details: { exitCode: 0, stdout: 'hello' },
          content: [{ type: 'text', text: 'hello' }],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      expect(result.message).not.toHaveProperty('details');
      expect(result.message.toolName).toBe('bash');
    });

    it('truncates long text content to 100 chars', () => {
      const longText = 'a'.repeat(300);
      const entry = {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'read',
          content: [{ type: 'text', text: longText }],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      expect(typeof block.text).toBe('string');
      expect((block.text as string).length).toBe(100);
    });

    it('does not truncate text content already under 100 chars', () => {
      const entry = {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'read',
          content: [{ type: 'text', text: 'short result' }],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      expect(block.text).toBe('short result');
    });

    it('passes through non-text content blocks unchanged', () => {
      const entry = {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'read',
          content: [{ type: 'image', data: 'base64...' }],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      expect(block.type).toBe('image');
      expect(block.data).toBe('base64...');
    });

    it('does not crash with empty content array', () => {
      const entry = {
        type: 'message',
        message: { role: 'toolResult', toolName: 'bash', content: [] },
      };
      expect(() => stripSessionEntry(entry)).not.toThrow();
    });

    it('truncates string-form content to 100 chars', () => {
      const entry = {
        type: 'message',
        message: { role: 'toolResult', toolName: 'bash', content: 'x'.repeat(300) },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      expect(typeof result.message.content).toBe('string');
      expect((result.message.content as string).length).toBe(100);
    });

    it('does not truncate string-form content already under 100 chars', () => {
      const entry = {
        type: 'message',
        message: { role: 'toolResult', toolName: 'bash', content: 'short' },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      expect(result.message.content).toBe('short');
    });
  });
});

describe('registerNarratorJobs (network guard)', () => {
  /** Fake Scheduler that captures registered handlers by name. */
  function mockScheduler() {
    const handlers: Record<string, () => Promise<void>> = {};
    return {
      schedule(name: string, _pattern: string, handler: () => Promise<void>) {
        handlers[name] = handler;
      },
      handlers,
    };
  }

  it('records skipped status when network is unavailable (daily-summary)', async () => {
    mockIsNetworkAvailable.mockResolvedValueOnce(false);
    const scheduler = mockScheduler();
    const host = mockNarratorHost();
    const dir = trackTmpDir(makeTmpDir());

    const mockDb = {
      createJobExecution: vi.fn(() => ({ id: 1 })),
      skipJobExecution: vi.fn(),
    } as unknown as DatabaseClient;

    registerNarratorJobs(scheduler as unknown as Scheduler, host, 2, mockDb, dir, 30);

    await scheduler.handlers['daily-summary']();
    expect(host.calls).toHaveLength(0);
    expect(mockDb.createJobExecution).toHaveBeenCalledWith('daily-summary', 'cron');
    expect(mockDb.skipJobExecution).toHaveBeenCalledWith(1, 'no network connectivity');
  });

  it('records skipped status when network is unavailable (memory-update)', async () => {
    mockIsNetworkAvailable.mockResolvedValueOnce(false);
    const scheduler = mockScheduler();
    const host = mockNarratorHost();
    const dir = trackTmpDir(makeTmpDir());

    const mockDb = {
      createJobExecution: vi.fn(() => ({ id: 1 })),
      skipJobExecution: vi.fn(),
    } as unknown as DatabaseClient;

    registerNarratorJobs(scheduler as unknown as Scheduler, host, 2, mockDb, dir, 30);

    await scheduler.handlers['memory-update']();
    expect(host.calls).toHaveLength(0);
    expect(mockDb.createJobExecution).toHaveBeenCalledWith('memory-update', 'cron');
    expect(mockDb.skipJobExecution).toHaveBeenCalledWith(1, 'no network connectivity');
  });

  it('proceeds with daily-summary when network is available', async () => {
    mockIsNetworkAvailable.mockResolvedValueOnce(true);
    const scheduler = mockScheduler();
    const host = mockNarratorHost();
    const dir = trackTmpDir(makeTmpDir());
    mkdirSync(join(dir, 'knowledge', 'daily_summaries'), { recursive: true });

    const mockDb = {
      query: () => [],
      createJobExecution: vi.fn(() => ({ id: 1 })),
      skipJobExecution: vi.fn(),
    } as unknown as DatabaseClient;

    registerNarratorJobs(scheduler as unknown as Scheduler, host, 2, mockDb, dir, 30);

    await scheduler.handlers['daily-summary']();

    // buildAndDeliverDailySummary was reached: it creates today's summary file
    const today = new Date().toISOString().slice(0, 10);
    expect(existsSync(join(dir, 'knowledge', 'daily_summaries', `${today}.md`))).toBe(true);
    // With no agents/projects and no activity, job is skipped (not completed)
    expect(host.calls).toHaveLength(0);
    expect(mockDb.skipJobExecution).toHaveBeenCalledWith(1, 'no activity since last run');
  });

  it('proceeds with memory-update when network is available', async () => {
    mockIsNetworkAvailable.mockResolvedValueOnce(true);
    const scheduler = mockScheduler();
    const host = mockNarratorHost();
    const dir = trackTmpDir(makeTmpDir());
    const knowledgeDir = join(dir, 'knowledge');
    const summariesDir = join(knowledgeDir, 'daily_summaries');
    mkdirSync(summariesDir, { recursive: true });
    writeFileSync(join(knowledgeDir, 'memory.md'), '---\nlast_narrator_update_ts:\n---\n');
    writeFileSync(join(summariesDir, '2026-03-24.md'), '---\n---\n# Summary');

    const mockDb = {
      createJobExecution: () => ({ id: 1 }),
      completeJobExecution: () => {},
    } as unknown as DatabaseClient;

    registerNarratorJobs(scheduler as unknown as Scheduler, host, 2, mockDb, dir, 30);

    await scheduler.handlers['memory-update']();
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0].content).toContain('[Scheduled task: memory-update]');
  });
});

describe('buildAndDeliverDailySummary', () => {
  const FIXED_NOW = new Date('2026-03-15T14:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mockHost(): AgentHost & { calls: Array<{ content: string; details: unknown }> } {
    const calls: Array<{ content: string; details: unknown }> = [];
    return {
      calls,
      deliverMessage(content: string, details: unknown) {
        calls.push({ content, details });
        return Promise.resolve();
      },
    } as unknown as AgentHost & { calls: Array<{ content: string; details: unknown }> };
  }

  function mockDb(
    agents: Array<{ id: number; role: string; project_name: string | null }>,
    projects: Array<{ id: number; name: string }> = []
  ): DatabaseClient {
    return {
      query(sql: string) {
        if (sql.includes('FROM agent')) return agents;
        if (sql.includes('FROM project p')) return projects;
        return [];
      },
    } as unknown as DatabaseClient;
  }

  it('throws JobSkipped when file has content but no new activity', async () => {
    const dir = trackTmpDir(makeTmpDir());
    const summariesDir = join(dir, 'knowledge', 'daily_summaries');
    mkdirSync(summariesDir, { recursive: true });

    writeFileSync(
      join(summariesDir, '2026-03-15.md'),
      '---\nlast_narrator_update_ts: 2020-01-01T00:00:00Z\n---\n# Daily Summary — 2026-03-15\n\n## 09:00\nSome prior narrative.'
    );

    const host = mockHost();
    const db = mockDb([{ id: 1, role: 'guide', project_name: null }]);
    await expect(buildAndDeliverDailySummary(db, host, 99, dir, 30)).rejects.toThrow(JobSkipped);
    expect(host.calls).toHaveLength(0);
  });

  it('throws JobSkipped on first run with no activity', async () => {
    const dir = trackTmpDir(makeTmpDir());

    const host = mockHost();
    const db = mockDb([{ id: 1, role: 'guide', project_name: null }]);
    await expect(buildAndDeliverDailySummary(db, host, 99, dir, 30)).rejects.toThrow(JobSkipped);
    expect(host.calls).toHaveLength(0);
  });

  it('fails when prior summaries exist but none have timestamps', async () => {
    const dir = trackTmpDir(makeTmpDir());
    const summariesDir = join(dir, 'knowledge', 'daily_summaries');
    mkdirSync(summariesDir, { recursive: true });

    // A prior summary file with empty frontmatter (no last_narrator_update_ts)
    writeFileSync(
      join(summariesDir, '2026-03-10.md'),
      '---\nlast_narrator_update_ts:\n---\n# Daily Summary\n'
    );

    const host = mockHost();
    const db = mockDb([{ id: 1, role: 'guide', project_name: null }]);
    await expect(buildAndDeliverDailySummary(db, host, 99, dir, 30)).rejects.toThrow(
      'last_narrator_update_ts not found'
    );
  });

  it('delivers when non-project agent has JSONL activity', async () => {
    const dir = trackTmpDir(makeTmpDir());
    const summariesDir = join(dir, 'knowledge', 'daily_summaries');
    const sessionDir = join(dir, 'sessions', 'guide_1');
    mkdirSync(summariesDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    // Set lastRunTs to 10 minutes ago, entry timestamp to 5 minutes ago
    const lastRunTs = new Date(Date.now() - 10 * 60_000).toISOString();
    const entryTs = new Date(Date.now() - 5 * 60_000).toISOString();
    writeFileSync(
      join(summariesDir, '2026-03-15.md'),
      `---\nlast_narrator_update_ts: ${lastRunTs}\n---\n# Daily Summary — 2026-03-15\n`
    );

    const entry = JSON.stringify({
      type: 'message',
      timestamp: entryTs,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello from guide' }] },
    });
    writeFileSync(join(sessionDir, 'session.jsonl'), entry);

    const host = mockHost();
    const db = mockDb([{ id: 1, role: 'guide', project_name: null }]);
    await buildAndDeliverDailySummary(db, host, 99, dir, 30);

    expect(host.calls).toHaveLength(1);
    expect(host.calls[0].content).toContain('[Scheduled task: daily-summary]');
  });

  it('delivers when project has DB changes', async () => {
    const dir = trackTmpDir(makeTmpDir());

    const host = mockHost();
    const db = {
      query(sql: string) {
        if (sql.includes('FROM agent')) {
          return [
            { id: 1, role: 'guide', project_name: null },
            { id: 2, role: 'conductor', project_name: 'TestProject' },
          ];
        }
        if (sql.includes('FROM project p')) {
          return [{ id: 1, name: 'TestProject' }];
        }
        // Return task rows only for project-scoped queries (not non-project)
        if (sql.includes('project = 1') || sql.includes('t.project = 1')) {
          return [{ id: 10, title: 'A task', status: 'done', project: 1 }];
        }
        return [];
      },
    } as unknown as DatabaseClient;

    await buildAndDeliverDailySummary(db, host, 99, dir, 30);

    expect(host.calls.length).toBeGreaterThanOrEqual(1);
    const messages = host.calls.map((c) => c.content);
    expect(messages.some((m) => m.includes('[Scheduled task: daily-summary]'))).toBe(true);
  });

  it('does not embed existing file content in the delivered message', async () => {
    const dir = trackTmpDir(makeTmpDir());
    const summariesDir = join(dir, 'knowledge', 'daily_summaries');
    const sessionDir = join(dir, 'sessions', 'guide_1');
    mkdirSync(summariesDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    const lastRunTs = new Date(Date.now() - 10 * 60_000).toISOString();
    const entryTs = new Date(Date.now() - 5 * 60_000).toISOString();
    writeFileSync(
      join(summariesDir, '2026-03-15.md'),
      `---\nlast_narrator_update_ts: ${lastRunTs}\n---\n# Daily Summary — 2026-03-15\n\n## 09:00\nPrior narrative here.`
    );

    const entry = JSON.stringify({
      type: 'message',
      timestamp: entryTs,
      message: { role: 'assistant', content: [{ type: 'text', text: 'guide activity' }] },
    });
    writeFileSync(join(sessionDir, 'session.jsonl'), entry);

    const host = mockHost();
    const db = mockDb([{ id: 1, role: 'guide', project_name: null }]);
    await buildAndDeliverDailySummary(db, host, 99, dir, 30);

    expect(host.calls).toHaveLength(1);
    expect(host.calls[0].content).not.toContain('Prior narrative here.');
  });

  it('excludes inactive projects from the message', async () => {
    const dir = trackTmpDir(makeTmpDir());
    const sessionDir = join(dir, 'sessions', 'guide_1');
    mkdirSync(sessionDir, { recursive: true });

    const lastRunTs = new Date(Date.now() - 10 * 60_000).toISOString();
    const entryTs = new Date(Date.now() - 5 * 60_000).toISOString();

    // Guide has activity (so the message gets delivered), but the project has none
    const entry = JSON.stringify({
      type: 'message',
      timestamp: entryTs,
      message: { role: 'assistant', content: [{ type: 'text', text: 'guide work' }] },
    });
    writeFileSync(join(sessionDir, 'session.jsonl'), entry);

    const summariesDir = join(dir, 'knowledge', 'daily_summaries');
    mkdirSync(summariesDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(
      join(summariesDir, `${today}.md`),
      `---\nlast_narrator_update_ts: ${lastRunTs}\n---\n# Daily Summary\n`
    );

    const host = mockHost();
    const db = mockDb(
      [
        { id: 1, role: 'guide', project_name: null },
        { id: 2, role: 'conductor', project_name: 'InactiveProject' },
      ],
      [{ id: 1, name: 'InactiveProject' }]
    );
    await buildAndDeliverDailySummary(db, host, 99, dir, 30);

    const dailySummaryMsg = host.calls
      .map((c) => c.content)
      .find((m) => m.includes('[Scheduled task: daily-summary]'));
    expect(dailySummaryMsg).toBeDefined();
    expect(dailySummaryMsg).not.toContain('## Project Activity');
    expect(dailySummaryMsg).not.toContain('InactiveProject');
    expect(dailySummaryMsg).toContain('## Non-Project Activity');
  });

  it('includes only active projects when multiple exist', async () => {
    const dir = trackTmpDir(makeTmpDir());

    const host = mockHost();
    const db = {
      query(sql: string) {
        if (sql.includes('FROM agent')) {
          return [
            { id: 1, role: 'guide', project_name: null },
            { id: 2, role: 'conductor', project_name: 'ActiveProject' },
            { id: 3, role: 'conductor', project_name: 'IdleProject' },
          ];
        }
        if (sql.includes('FROM project p')) {
          return [
            { id: 1, name: 'ActiveProject' },
            { id: 2, name: 'IdleProject' },
          ];
        }
        // Return task rows only for project 1 (ActiveProject)
        if (sql.includes('project = 1') || sql.includes('t.project = 1')) {
          return [{ id: 10, title: 'A task', status: 'done', project: 1 }];
        }
        return [];
      },
    } as unknown as DatabaseClient;

    await buildAndDeliverDailySummary(db, host, 99, dir, 30);

    const dailySummaryMsg = host.calls
      .map((c) => c.content)
      .find((m) => m.includes('[Scheduled task: daily-summary]'));
    expect(dailySummaryMsg).toBeDefined();
    expect(dailySummaryMsg).toContain('ActiveProject');
    expect(dailySummaryMsg).not.toContain('IdleProject');
  });

  it('omits Non-Project Activity section when only projects have changes', async () => {
    const dir = trackTmpDir(makeTmpDir());

    const host = mockHost();
    const db = {
      query(sql: string) {
        if (sql.includes('FROM agent')) {
          return [
            { id: 1, role: 'guide', project_name: null },
            { id: 2, role: 'conductor', project_name: 'TestProject' },
          ];
        }
        if (sql.includes('FROM project p')) {
          return [{ id: 1, name: 'TestProject' }];
        }
        // Return task rows only for project-scoped queries (not non-project)
        if (sql.includes('project = 1') || sql.includes('t.project = 1')) {
          return [{ id: 10, title: 'A task', status: 'done', project: 1 }];
        }
        return [];
      },
    } as unknown as DatabaseClient;

    await buildAndDeliverDailySummary(db, host, 99, dir, 30);

    const dailySummaryMsg = host.calls
      .map((c) => c.content)
      .find((m) => m.includes('[Scheduled task: daily-summary]'));
    expect(dailySummaryMsg).toBeDefined();
    expect(dailySummaryMsg).toContain('## Project Activity');
    expect(dailySummaryMsg).not.toContain('## Non-Project Activity');
  });

  it('advances frontmatter cursor on successful delivery', async () => {
    const dir = trackTmpDir(makeTmpDir());
    const summariesDir = join(dir, 'knowledge', 'daily_summaries');
    const sessionDir = join(dir, 'sessions', 'guide_1');
    mkdirSync(summariesDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    // Seed with a recent timestamp for the time window
    const lastRunTs = new Date(Date.now() - 10 * 60_000).toISOString();
    const entryTs = new Date(Date.now() - 5 * 60_000).toISOString();

    writeFileSync(
      join(summariesDir, '2026-03-15.md'),
      `---\nlast_narrator_update_ts: ${lastRunTs}\n---\n# Daily Summary\n`
    );

    // Create JSONL activity within the time window
    const entry = JSON.stringify({
      type: 'message',
      timestamp: entryTs,
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
    writeFileSync(join(sessionDir, 'session.jsonl'), entry);

    const host = mockHost();
    const db = mockDb([{ id: 1, role: 'guide', project_name: null }]);
    await buildAndDeliverDailySummary(db, host, 99, dir, 30);

    // Server should have advanced the cursor in today's file (not relying on LLM)
    const today = new Date().toISOString().slice(0, 10);
    const todayFile = join(summariesDir, `${today}.md`);
    const cursor = readFrontmatterField(todayFile, 'last_narrator_update_ts');
    expect(cursor).not.toBeNull();
    expect(cursor).not.toBe(lastRunTs);
  });

  it('advances frontmatter cursor even on skip (no activity)', async () => {
    const dir = trackTmpDir(makeTmpDir());
    const summariesDir = join(dir, 'knowledge', 'daily_summaries');
    mkdirSync(summariesDir, { recursive: true });

    const lastRunTs = new Date(Date.now() - 10 * 60_000).toISOString();
    writeFileSync(
      join(summariesDir, '2026-03-15.md'),
      `---\nlast_narrator_update_ts: ${lastRunTs}\n---\n# Daily Summary\n`
    );

    const host = mockHost();
    const db = mockDb([{ id: 1, role: 'guide', project_name: null }]);
    await expect(buildAndDeliverDailySummary(db, host, 99, dir, 30)).rejects.toThrow(JobSkipped);

    // Cursor should still advance in today's file to prevent re-scanning the same window
    const today = new Date().toISOString().slice(0, 10);
    const todayFile = join(summariesDir, `${today}.md`);
    const cursor = readFrontmatterField(todayFile, 'last_narrator_update_ts');
    expect(cursor).not.toBeNull();
    expect(cursor).not.toBe(lastRunTs);
  });

  it('truncates oversized catch-up activity to fit the budget and includes a dropped-range note', async () => {
    const dir = trackTmpDir(makeTmpDir());
    const summariesDir = join(dir, 'knowledge', 'daily_summaries');
    const sessionDir = join(dir, 'sessions', 'guide_1');
    mkdirSync(summariesDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    // Set lastRunTs to a wide window so all 100 entries fall inside
    const lastRunTs = new Date(Date.now() - 60 * 60_000).toISOString(); // 1 hour ago
    writeFileSync(
      join(summariesDir, '2026-03-15.md'),
      `---\nlast_narrator_update_ts: ${lastRunTs}\n---\n# Daily Summary — 2026-03-15\n`
    );

    // Build 100 entries totalling ~1 MB. Each rendered entry is ~10 KB.
    // Timestamps are spaced 10 seconds apart so they're sortable.
    const baseTime = Date.now() - 50 * 60_000; // 50 minutes ago
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      const ts = new Date(baseTime + i * 10_000).toISOString();
      lines.push(
        JSON.stringify({
          type: 'custom_message',
          timestamp: ts,
          content: `entry-${i}-${'x'.repeat(10_000)}`,
        })
      );
    }
    writeFileSync(join(sessionDir, 'session.jsonl'), lines.join('\n'));

    const host = mockHost();
    const db = mockDb([{ id: 1, role: 'guide', project_name: null }]);
    // Use a tight catch-up budget (100 KB) to deterministically trigger truncation
    // regardless of future default-budget changes.
    const tightBudget = 100 * 1024;
    await buildAndDeliverDailySummary(db, host, 99, dir, 30, tightBudget);

    // Should have delivered exactly one message (daily-summary; no projects)
    expect(host.calls).toHaveLength(1);
    const deliveredContent = host.calls[0].content;

    // Must be within the tight catch-up budget plus overhead — well under MAX_DELIVERY_BYTES
    expect(Buffer.byteLength(deliveredContent, 'utf8')).toBeLessThanOrEqual(MAX_DELIVERY_BYTES);

    // Must contain the dropped-range note
    expect(deliveredContent).toContain('[NOTE: dropped');
    expect(deliveredContent).toContain('oldest entries spanning');
    expect(deliveredContent).toContain('to fit');

    // Cursor must have advanced to newRunTs
    const today = new Date().toISOString().slice(0, 10);
    const todayFile = join(summariesDir, `${today}.md`);
    const cursor = readFrontmatterField(todayFile, 'last_narrator_update_ts');
    expect(cursor).not.toBeNull();
    expect(cursor).not.toBe(lastRunTs);
  });

  it('emits log.warn when catch-up activity truncation drops entries', async () => {
    const dir = trackTmpDir(makeTmpDir());
    const summariesDir = join(dir, 'knowledge', 'daily_summaries');
    const sessionDir = join(dir, 'sessions', 'guide_1');
    mkdirSync(summariesDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    const lastRunTs = new Date(Date.now() - 60 * 60_000).toISOString();
    writeFileSync(
      join(summariesDir, '2026-03-15.md'),
      `---\nlast_narrator_update_ts: ${lastRunTs}\n---\n# Daily Summary — 2026-03-15\n`
    );

    // Build entries large enough to trigger truncation at a 100 KB budget
    const baseTime = Date.now() - 50 * 60_000;
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      const ts = new Date(baseTime + i * 10_000).toISOString();
      lines.push(
        JSON.stringify({
          type: 'custom_message',
          timestamp: ts,
          content: `entry-${i}-${'x'.repeat(10_000)}`,
        })
      );
    }
    writeFileSync(join(sessionDir, 'session.jsonl'), lines.join('\n'));

    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const host = mockHost();
    const db = mockDb([{ id: 1, role: 'guide', project_name: null }]);
    const tightBudget = 100 * 1024;
    await buildAndDeliverDailySummary(db, host, 99, dir, 30, tightBudget);

    const warnCalls = warnSpy.mock.calls.map((args) => args.join(' '));
    const truncationWarn = warnCalls.find(
      (msg) => msg.includes('[Scheduler] Truncated') && msg.includes('oldest activity entries')
    );
    expect(truncationWarn).toBeDefined();
    expect(truncationWarn).toContain('non-project daily summary delivery');
    expect(truncationWarn).toContain('byte budget');

    warnSpy.mockRestore();
  });
});

describe('trackJobExecution', () => {
  function mockDbForTracking() {
    return {
      createJobExecution: vi.fn(() => ({ id: 42, job_name: 'test-job', status: 'running' })),
      completeJobExecution: vi.fn(() => ({ id: 42, status: 'completed' })),
      failJobExecution: vi.fn(() => ({ id: 42, status: 'failed' })),
      skipJobExecution: vi.fn(() => ({ id: 42, status: 'skipped' })),
    } as unknown as DatabaseClient;
  }

  it('creates a running record and completes it on success', async () => {
    const db = mockDbForTracking();
    const handler = vi.fn();

    await trackJobExecution(db, 'test-job', 'cron', handler);

    expect(db.createJobExecution).toHaveBeenCalledWith('test-job', 'cron');
    expect(handler).toHaveBeenCalled();
    expect(db.completeJobExecution).toHaveBeenCalledWith(42);
    expect(db.failJobExecution).not.toHaveBeenCalled();
  });

  it('creates a running record and fails it on error', async () => {
    const db = mockDbForTracking();
    const handler = vi.fn(() => {
      throw new Error('something broke');
    });

    await expect(trackJobExecution(db, 'test-job', 'catch-up', handler)).rejects.toThrow(
      'something broke'
    );

    expect(db.createJobExecution).toHaveBeenCalledWith('test-job', 'catch-up');
    expect(db.failJobExecution).toHaveBeenCalledWith(
      42,
      expect.stringContaining('something broke')
    );
    expect(db.completeJobExecution).not.toHaveBeenCalled();
  });

  it('records skipped status on JobSkipped and does not re-throw', async () => {
    const db = mockDbForTracking();
    const handler = vi.fn(() => {
      throw new JobSkipped('no activity since last run');
    });

    await trackJobExecution(db, 'test-job', 'cron', handler);

    expect(db.skipJobExecution).toHaveBeenCalledWith(42, 'no activity since last run');
    expect(db.completeJobExecution).not.toHaveBeenCalled();
    expect(db.failJobExecution).not.toHaveBeenCalled();
  });

  it('re-throws the original error after recording failure', async () => {
    const db = mockDbForTracking();
    const originalError = new Error('original');
    const handler = vi.fn(() => {
      throw originalError;
    });

    try {
      await trackJobExecution(db, 'test-job', 'manual', handler);
    } catch (error) {
      expect(error).toBe(originalError);
    }
  });

  it('handles non-Error thrown values', async () => {
    const db = mockDbForTracking();
    const handler = vi.fn(() => {
      throw 'string error';
    });

    await expect(trackJobExecution(db, 'test-job', 'cron', handler)).rejects.toThrow();

    expect(db.failJobExecution).toHaveBeenCalledWith(42, 'string error');
  });

  it('works with async handlers', async () => {
    const db = mockDbForTracking();
    const handler = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });

    await trackJobExecution(db, 'test-job', 'cron', handler);

    expect(db.completeJobExecution).toHaveBeenCalledWith(42);
  });

  it('does not break when onJobChange callback throws', async () => {
    const db = mockDbForTracking();
    const handler = vi.fn();
    const onJobChange = vi.fn(() => {
      throw new Error('broadcast failed');
    });

    await trackJobExecution(db, 'test-job', 'cron', handler, onJobChange);

    expect(handler).toHaveBeenCalled();
    expect(db.completeJobExecution).toHaveBeenCalledWith(42);
    expect(onJobChange).toHaveBeenCalledTimes(2);
  });

  it('does not break on failure path when onJobChange callback throws', async () => {
    const db = mockDbForTracking();
    const handler = vi.fn(() => {
      throw new Error('handler failed');
    });
    const onJobChange = vi.fn(() => {
      throw new Error('broadcast failed');
    });

    await expect(trackJobExecution(db, 'test-job', 'cron', handler, onJobChange)).rejects.toThrow(
      'handler failed'
    );

    expect(db.failJobExecution).toHaveBeenCalledWith(42, expect.stringContaining('handler failed'));
  });
});
