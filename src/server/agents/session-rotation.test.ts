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

  describe('unified threshold — anchored vs bare-bytes-tail paths', () => {
    it('size >= threshold AND compaction anchor present: anchored rotation runs', () => {
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
      // Old file archived
      expect(existsSync(file)).toBe(false);
      expect(existsSync(`${file}.archived`)).toBe(true);

      // New file: header + entries from firstKeptEntryId onward (e1, e2, c1, e3)
      const newFile = findMostRecentSession(tmpDir);
      expect(newFile).not.toBeNull();
      const newEntries = readFileSync(newFile as string, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(newEntries[0].type).toBe('session');
      const ids = newEntries.map((e: { id?: string }) => e.id);
      expect(ids).toContain('e1');
      expect(ids).toContain('e2');
      expect(ids).toContain('c1');
      expect(ids).toContain('e3');
    });

    it('size >= threshold AND no compaction anchor: bare-bytes-tail rotation runs, emits warn', () => {
      const file = join(tmpDir, 'session.jsonl');
      const entries: object[] = [sessionHeader()];
      for (let i = 0; i < 64; i++) {
        const prev = i === 0 ? null : `e${i - 1}`;
        entries.push(messageEntry(`e${i}`, prev, i % 2 === 0 ? 'user' : 'assistant'));
      }
      writeJsonl(file, entries);

      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
      // threshold=0 forces past the gate. No compaction anchor → bare-bytes-tail path.
      const rotated = rotateSessionIfNeeded(tmpDir, '/tmp', 0);

      expect(rotated).toBe(true);
      // Old file archived
      expect(existsSync(file)).toBe(false);
      expect(existsSync(`${file}.archived`)).toBe(true);

      // New file: header + tail entries within ~1 MB
      const newFile = findMostRecentSession(tmpDir);
      expect(newFile).not.toBeNull();
      const newEntries = readFileSync(newFile as string, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(newEntries[0].type).toBe('session');
      const ids = newEntries.map((e: { id?: string }) => e.id);
      // Newest entry must be retained
      expect(ids).toContain('e63');

      // Total tail bytes (excluding header) should be <= ~1 MB
      const tailBytes = newEntries
        .slice(1)
        .reduce((acc: number, e: object) => acc + Buffer.byteLength(JSON.stringify(e), 'utf8'), 0);
      expect(tailBytes).toBeLessThanOrEqual(1 * 1024 * 1024);

      // Warn must mention bare-bytes-tail rotation + path + size
      const warnText = warnSpy.mock.calls.flat().map(String).join(' ');
      expect(warnText).toContain('No compaction found');
      expect(warnText).toContain('bare-bytes-tail');
      expect(warnText).toContain(file);
      expect(warnText).toMatch(/\d+\.\d+ MB/);
      warnSpy.mockRestore();
    });

    it('size < threshold: returns false, no rotation, no warn', () => {
      const file = join(tmpDir, 'session.jsonl');
      writeJsonl(file, [
        sessionHeader(),
        messageEntry('e1', null, 'user'),
        messageEntry('e2', 'e1', 'assistant'),
      ]);

      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
      // Threshold far above file size — no-op
      const rotated = rotateSessionIfNeeded(tmpDir, '/tmp', 50 * 1024 * 1024);

      expect(rotated).toBe(false);
      // File untouched
      expect(existsSync(file)).toBe(true);
      expect(existsSync(`${file}.archived`)).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('bare-bytes-tail caps tail at ~1 MB even when entries are very large', () => {
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
      const rotated = rotateSessionIfNeeded(tmpDir, '/tmp', 0);

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

    it('bare-bytes-tail cut lands on a user-turn boundary, never on assistant/tool', () => {
      // Setup: assistant, assistant, assistant, user, assistant, assistant
      // Without user-turn alignment, the kept tail could start on an assistant
      // entry, leaving a dangling continuation when the SDK restores.
      const file = join(tmpDir, 'session.jsonl');
      const entries: object[] = [
        sessionHeader(),
        messageEntry('a1', null, 'assistant'),
        messageEntry('a2', 'a1', 'assistant'),
        messageEntry('a3', 'a2', 'assistant'),
        messageEntry('u1', 'a3', 'user'),
        messageEntry('a4', 'u1', 'assistant'),
        messageEntry('a5', 'a4', 'assistant'),
      ];
      writeJsonl(file, entries);

      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const rotated = rotateSessionIfNeeded(tmpDir, '/tmp', 0);
      expect(rotated).toBe(true);

      const newFile = findMostRecentSession(tmpDir);
      const newEntries = readFileSync(newFile as string, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));

      // First entry is the new session header, second must be the user turn 'u1'.
      expect(newEntries[0].type).toBe('session');
      expect(newEntries[1].id).toBe('u1');
      expect(newEntries[1].message.role).toBe('user');
      warnSpy.mockRestore();
    });

    it('returns header-only when the newest entry alone exceeds the tail cap', () => {
      // Single entry larger than HARD_FALLBACK_TAIL_BYTES (1 MB). Strict cap means
      // we drop it rather than writing a rotated file still > 1 MB.
      const file = join(tmpDir, 'session.jsonl');
      const huge = 'x'.repeat(2 * 1024 * 1024); // 2 MB string
      writeJsonl(file, [
        sessionHeader(),
        {
          type: 'message',
          id: 'huge1',
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: [{ type: 'text', text: huge }] },
        },
      ]);

      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const rotated = rotateSessionIfNeeded(tmpDir, '/tmp', 0);
      expect(rotated).toBe(true);

      const newFile = findMostRecentSession(tmpDir);
      const newEntries = readFileSync(newFile as string, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));

      // Only the new session header should remain.
      expect(newEntries.length).toBe(1);
      expect(newEntries[0].type).toBe('session');
      warnSpy.mockRestore();
    });

    it('returns header-only when kept range has no user turn (no safe restart anchor)', () => {
      // All entries are assistant — no user turn exists to anchor the resume on.
      // selectTailEntries walks past everything; rotation writes only the new header.
      const file = join(tmpDir, 'session.jsonl');
      const entries: object[] = [
        sessionHeader(),
        messageEntry('a1', null, 'assistant'),
        messageEntry('a2', 'a1', 'assistant'),
        messageEntry('a3', 'a2', 'assistant'),
      ];
      writeJsonl(file, entries);

      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const rotated = rotateSessionIfNeeded(tmpDir, '/tmp', 0);
      expect(rotated).toBe(true);

      const newFile = findMostRecentSession(tmpDir);
      const newEntries = readFileSync(newFile as string, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));

      // Only the new session header should remain.
      expect(newEntries.length).toBe(1);
      expect(newEntries[0].type).toBe('session');
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
