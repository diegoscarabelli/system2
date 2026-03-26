import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { findMostRecentSession, rotateSessionIfNeeded } from './session-rotation.js';

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `session-rotation-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJsonl(path: string, entries: object[]): void {
  writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

function sessionHeader(id = 'abc12345'): object {
  return { type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: '/tmp' };
}

function messageEntry(id: string, parentId: string | null, role: string): object {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: 'text', text: `msg ${id}` }] },
  };
}

function compactionEntry(id: string, parentId: string, firstKeptEntryId: string): object {
  return {
    type: 'compaction',
    id,
    parentId,
    timestamp: new Date().toISOString(),
    summary: 'Summary of earlier messages.',
    firstKeptEntryId,
    tokensBefore: 5000,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTmpDir();
});

describe('findMostRecentSession', () => {
  it('returns null when directory does not exist', () => {
    expect(findMostRecentSession('/nonexistent/path/xyz')).toBeNull();
  });

  it('returns null when directory is empty', () => {
    expect(findMostRecentSession(tmpDir)).toBeNull();
  });

  it('returns null when directory has no .jsonl files', () => {
    writeFileSync(join(tmpDir, 'session.txt'), 'hello');
    expect(findMostRecentSession(tmpDir)).toBeNull();
  });

  it('returns the single .jsonl file when only one exists', () => {
    const file = join(tmpDir, 'session.jsonl');
    writeFileSync(file, '');
    expect(findMostRecentSession(tmpDir)).toBe(file);
  });

  it('returns the most recently modified .jsonl file', async () => {
    const older = join(tmpDir, 'older.jsonl');
    writeFileSync(older, '');
    // Small delay to ensure distinct mtime
    await new Promise((r) => setTimeout(r, 10));
    const newer = join(tmpDir, 'newer.jsonl');
    writeFileSync(newer, '');
    expect(findMostRecentSession(tmpDir)).toBe(newer);
  });

  it('ignores .jsonl.archived files', () => {
    writeFileSync(join(tmpDir, 'session.jsonl.archived'), '');
    expect(findMostRecentSession(tmpDir)).toBeNull();
  });
});

describe('rotateSessionIfNeeded', () => {
  it('returns false when no session file exists', () => {
    expect(rotateSessionIfNeeded(tmpDir, '/tmp', 0)).toBe(false);
  });

  it('returns false when file is below the threshold', () => {
    const file = join(tmpDir, 'session.jsonl');
    writeJsonl(file, [sessionHeader()]);
    expect(rotateSessionIfNeeded(tmpDir, '/tmp', 10 * 1024 * 1024)).toBe(false);
  });

  it('returns false when file has no compaction entry', () => {
    const file = join(tmpDir, 'session.jsonl');
    writeJsonl(file, [
      sessionHeader(),
      messageEntry('e1', null, 'user'),
      messageEntry('e2', 'e1', 'assistant'),
    ]);
    expect(rotateSessionIfNeeded(tmpDir, '/tmp', 0)).toBe(false);
  });

  it('returns false when firstKeptEntryId is not found', () => {
    const file = join(tmpDir, 'session.jsonl');
    writeJsonl(file, [
      sessionHeader(),
      messageEntry('e1', null, 'user'),
      compactionEntry('c1', 'e1', 'missing-id'),
    ]);
    expect(rotateSessionIfNeeded(tmpDir, '/tmp', 0)).toBe(false);
  });

  it('creates a new file and renames the old one to .archived on rotation', () => {
    const file = join(tmpDir, 'session.jsonl');
    writeJsonl(file, [
      sessionHeader(),
      messageEntry('e1', null, 'user'),
      messageEntry('e2', 'e1', 'assistant'),
      compactionEntry('c1', 'e2', 'e1'),
      messageEntry('e3', 'c1', 'user'),
    ]);

    const rotated = rotateSessionIfNeeded(tmpDir, '/tmp', 0);

    expect(rotated).toBe(true);
    // Old file renamed to .archived
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.archived`)).toBe(true);
    // New file exists
    const newFile = findMostRecentSession(tmpDir);
    expect(newFile).not.toBeNull();
    expect(newFile).not.toBe(file);
  });

  it('new file starts with a valid session header', () => {
    const file = join(tmpDir, 'session.jsonl');
    writeJsonl(file, [
      sessionHeader(),
      messageEntry('e1', null, 'user'),
      messageEntry('e2', 'e1', 'assistant'),
      compactionEntry('c1', 'e2', 'e1'),
      messageEntry('e3', 'c1', 'user'),
    ]);

    rotateSessionIfNeeded(tmpDir, '/tmp', 0);

    const newFile = findMostRecentSession(tmpDir);
    expect(newFile).not.toBeNull();
    const firstLine = readFileSync(newFile as string, 'utf-8').split('\n')[0];
    const parsed = JSON.parse(firstLine);
    expect(parsed.type).toBe('session');
    expect(typeof parsed.id).toBe('string');
  });

  it('new file contains kept entries, compaction, and post-compaction entries', () => {
    const file = join(tmpDir, 'session.jsonl');
    // e1=kept, e2=kept, c1=compaction(firstKept=e1), e3=post-compaction
    writeJsonl(file, [
      sessionHeader(),
      messageEntry('e1', null, 'user'),
      messageEntry('e2', 'e1', 'assistant'),
      compactionEntry('c1', 'e2', 'e1'),
      messageEntry('e3', 'c1', 'user'),
    ]);

    rotateSessionIfNeeded(tmpDir, '/tmp', 0);

    const newFile = findMostRecentSession(tmpDir);
    expect(newFile).not.toBeNull();
    const content = readFileSync(newFile as string, 'utf-8');
    const entries = content
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    const ids = entries.map((e: { id?: string }) => e.id);
    expect(ids).toContain('e1');
    expect(ids).toContain('e2');
    expect(ids).toContain('c1');
    expect(ids).toContain('e3');
  });
});
