import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../utils/logger.js';
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

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
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

  it('returns the most recently modified .jsonl file', () => {
    const older = join(tmpDir, 'older.jsonl');
    const newer = join(tmpDir, 'newer.jsonl');
    writeFileSync(older, '');
    writeFileSync(newer, '');
    // Set mtimes deterministically to avoid relying on filesystem timestamp resolution
    utimesSync(older, new Date(1000), new Date(1000));
    utimesSync(newer, new Date(2000), new Date(2000));
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

  describe('hard-fallback path (no compaction anchor)', () => {
    it('between regular threshold and hard fallback: returns false and emits warn with size', () => {
      const file = join(tmpDir, 'session.jsonl');
      writeJsonl(file, [
        sessionHeader(),
        messageEntry('e1', null, 'user'),
        messageEntry('e2', 'e1', 'assistant'),
      ]);

      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
      // threshold=0 forces past the regular gate; hardFallback is far above the file size
      const rotated = rotateSessionIfNeeded(tmpDir, '/tmp', 0, 50 * 1024 * 1024);

      expect(rotated).toBe(false);
      // Old file untouched
      expect(existsSync(file)).toBe(true);
      expect(existsSync(`${file}.archived`)).toBe(false);
      // Warn includes path + size
      const warnCalls = warnSpy.mock.calls.flat();
      const warnText = warnCalls.map(String).join(' ');
      expect(warnText).toContain('No compaction found');
      expect(warnText).toContain(file);
      expect(warnText).toMatch(/\d+\.\d+ MB/);
      warnSpy.mockRestore();
    });

    it('size >= hard fallback: archives old file, new file has header + tail entries within ~1 MB, emits warn', () => {
      const file = join(tmpDir, 'session.jsonl');
      // Build many small messages so the file exceeds the hard fallback (here we use a tiny
      // 4 KB hard fallback to keep the test fast). Tail cap stays at the production 1 MB; with
      // ~32 small entries the tail picks up everything (well within 1 MB).
      const entries: object[] = [sessionHeader()];
      for (let i = 0; i < 64; i++) {
        const prev = i === 0 ? null : `e${i - 1}`;
        entries.push(messageEntry(`e${i}`, prev, i % 2 === 0 ? 'user' : 'assistant'));
      }
      writeJsonl(file, entries);

      const fileSize = readFileSync(file, 'utf-8').length;
      // Pick a hard fallback below the file size to force the fallback path.
      const hardFallback = Math.max(Math.floor(fileSize / 2), 1);

      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const rotated = rotateSessionIfNeeded(tmpDir, '/tmp', 0, hardFallback);

      expect(rotated).toBe(true);
      // Old file archived
      expect(existsSync(file)).toBe(false);
      expect(existsSync(`${file}.archived`)).toBe(true);

      // New file exists, starts with a session header, contains tail entries
      const newFile = findMostRecentSession(tmpDir);
      expect(newFile).not.toBeNull();
      const newContent = readFileSync(newFile as string, 'utf-8');
      const newEntries = newContent
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(newEntries[0].type).toBe('session');
      // Newest entry must be retained
      const ids = newEntries.map((e: { id?: string }) => e.id);
      expect(ids).toContain('e63');

      // Total tail bytes (excluding header) should be <= ~1 MB
      const tailBytes = newEntries
        .slice(1)
        .reduce((acc: number, e: object) => acc + Buffer.byteLength(JSON.stringify(e), 'utf8'), 0);
      expect(tailBytes).toBeLessThanOrEqual(1 * 1024 * 1024);

      // Warn must mention forced fallback + size
      const warnCalls = warnSpy.mock.calls.flat();
      const warnText = warnCalls.map(String).join(' ');
      expect(warnText).toContain('No compaction found');
      expect(warnText).toContain('hard fallback');
      expect(warnText).toMatch(/\d+\.\d+ MB/);
      warnSpy.mockRestore();
    });

    it('hard fallback caps tail at ~1 MB even when entries are very large', () => {
      const file = join(tmpDir, 'session.jsonl');
      // 3 large entries of ~600 KB each; tail cap is 1 MB so only ~1-2 should fit.
      const big = 'x'.repeat(600 * 1024);
      const entries: object[] = [sessionHeader()];
      for (let i = 0; i < 3; i++) {
        entries.push({
          type: 'message',
          id: `e${i}`,
          parentId: i === 0 ? null : `e${i - 1}`,
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: [{ type: 'text', text: big }] },
        });
      }
      writeJsonl(file, entries);

      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
      // Force hard-fallback with a tiny threshold
      const rotated = rotateSessionIfNeeded(tmpDir, '/tmp', 0, 1);

      expect(rotated).toBe(true);
      const newFile = findMostRecentSession(tmpDir);
      expect(newFile).not.toBeNull();
      const newEntries = readFileSync(newFile as string, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));

      // Header + at most 2 tail entries (each ~600 KB; pair would be 1.2 MB > 1 MB)
      const tailEntryCount = newEntries.length - 1;
      expect(tailEntryCount).toBeGreaterThanOrEqual(1);
      expect(tailEntryCount).toBeLessThanOrEqual(2);

      // Newest entry always preserved
      const ids = newEntries.map((e: { id?: string }) => e.id);
      expect(ids).toContain('e2');
      warnSpy.mockRestore();
    });
  });

  describe('skip-path warn logs', () => {
    it('emits warn with file path + size when firstKeptEntryId is missing on the compaction', () => {
      const file = join(tmpDir, 'session.jsonl');
      // Compaction entry without firstKeptEntryId
      writeJsonl(file, [
        sessionHeader(),
        messageEntry('e1', null, 'user'),
        { type: 'compaction', id: 'c1', parentId: 'e1', timestamp: new Date().toISOString() },
      ]);

      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const rotated = rotateSessionIfNeeded(tmpDir, '/tmp', 0);

      expect(rotated).toBe(false);
      const warnText = warnSpy.mock.calls.flat().map(String).join(' ');
      expect(warnText).toContain('firstKeptEntryId');
      expect(warnText).toContain(file);
      expect(warnText).toMatch(/\d+\.\d+ MB/);
      warnSpy.mockRestore();
    });

    it('emits warn with file path + size when firstKeptEntryId is not present in the file', () => {
      const file = join(tmpDir, 'session.jsonl');
      writeJsonl(file, [
        sessionHeader(),
        messageEntry('e1', null, 'user'),
        compactionEntry('c1', 'e1', 'missing-id'),
      ]);

      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const rotated = rotateSessionIfNeeded(tmpDir, '/tmp', 0);

      expect(rotated).toBe(false);
      const warnText = warnSpy.mock.calls.flat().map(String).join(' ');
      expect(warnText).toContain('missing-id');
      expect(warnText).toContain(file);
      expect(warnText).toMatch(/\d+\.\d+ MB/);
      warnSpy.mockRestore();
    });
  });
});
