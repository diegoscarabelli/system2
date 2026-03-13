import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectAgentActivity,
  formatMarkdownTable,
  readFrontmatterField,
  readTailChars,
  resolveDailySummaryTimestamp,
} from './jobs.js';

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

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
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
