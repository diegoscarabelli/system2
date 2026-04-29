import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../utils/logger.js';
import { findMostRecentSession, pruneArchives, rotateSessionIfNeeded } from './session-rotation.js';

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

  describe('malformed-anchor fallback paths', () => {
    it('falls back to bare-bytes-tail when compaction is missing firstKeptEntryId', () => {
      const file = join(tmpDir, 'session.jsonl');
      writeJsonl(file, [
        sessionHeader(),
        messageEntry('e1', null, 'user'),
        messageEntry('e2', 'e1', 'assistant'),
        // Compaction entry without firstKeptEntryId
        { type: 'compaction', id: 'c1', parentId: 'e2', timestamp: new Date().toISOString() },
      ]);

      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const rotated = rotateSessionIfNeeded(tmpDir, '/tmp', 0);

      expect(rotated).toBe(true);
      // Old file archived
      expect(existsSync(file)).toBe(false);
      expect(existsSync(`${file}.archived`)).toBe(true);
      const warnText = warnSpy.mock.calls.flat().map(String).join(' ');
      expect(warnText).toContain('firstKeptEntryId');
      expect(warnText).toContain('bare-bytes-tail');
      expect(warnText).toContain(file);
      expect(warnText).toMatch(/\d+\.\d+ MB/);
      warnSpy.mockRestore();
    });

    it('falls back to bare-bytes-tail when firstKeptEntryId points to a missing entry', () => {
      const file = join(tmpDir, 'session.jsonl');
      writeJsonl(file, [
        sessionHeader(),
        messageEntry('e1', null, 'user'),
        compactionEntry('c1', 'e1', 'missing-id'),
      ]);

      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const rotated = rotateSessionIfNeeded(tmpDir, '/tmp', 0);

      expect(rotated).toBe(true);
      expect(existsSync(file)).toBe(false);
      expect(existsSync(`${file}.archived`)).toBe(true);
      const warnText = warnSpy.mock.calls.flat().map(String).join(' ');
      expect(warnText).toContain('missing-id');
      expect(warnText).toContain('bare-bytes-tail');
      expect(warnText).toContain(file);
      expect(warnText).toMatch(/\d+\.\d+ MB/);
      warnSpy.mockRestore();
    });

    it('falls back to header-only rotation when file parses to 0 entries', () => {
      const file = join(tmpDir, 'session.jsonl');
      // Write only malformed lines so parseSessionEntries returns 0 entries.
      writeFileSync(file, 'not-json\nstill-not-json\nbroken{lines\n');

      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const rotated = rotateSessionIfNeeded(tmpDir, '/tmp', 0);

      expect(rotated).toBe(true);
      expect(existsSync(file)).toBe(false);
      expect(existsSync(`${file}.archived`)).toBe(true);

      const newFile = findMostRecentSession(tmpDir);
      const newEntries = readFileSync(newFile as string, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      // Only the new session header
      expect(newEntries.length).toBe(1);
      expect(newEntries[0].type).toBe('session');

      const warnText = warnSpy.mock.calls.flat().map(String).join(' ');
      expect(warnText).toContain('parsed to 0 entries');
      expect(warnText).toContain('header-only');
      expect(warnText).toContain(file);
      expect(warnText).toMatch(/\d+\.\d+ MB/);
      warnSpy.mockRestore();
    });
  });
});

describe('pruneArchives', () => {
  function makeArchive(name: string, mtimeSeconds: number): string {
    const fullPath = join(tmpDir, name);
    writeFileSync(fullPath, 'archived content');
    utimesSync(fullPath, new Date(mtimeSeconds * 1000), new Date(mtimeSeconds * 1000));
    return fullPath;
  }

  it('keeps exactly keepCount newest archives by mtime', () => {
    const a = makeArchive('a.jsonl.archived', 1000);
    const b = makeArchive('b.jsonl.archived', 2000);
    const c = makeArchive('c.jsonl.archived', 3000);
    const d = makeArchive('d.jsonl.archived', 4000);
    const e = makeArchive('e.jsonl.archived', 5000);

    pruneArchives(tmpDir, 2);

    // Only the 2 newest (d, e) remain; a/b/c are pruned.
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(existsSync(c)).toBe(false);
    expect(existsSync(d)).toBe(true);
    expect(existsSync(e)).toBe(true);
  });

  it('is a no-op when there are fewer archives than keepCount', () => {
    const a = makeArchive('a.jsonl.archived', 1000);
    const b = makeArchive('b.jsonl.archived', 2000);

    pruneArchives(tmpDir, 5);

    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  it('is a no-op when count exactly equals keepCount', () => {
    const a = makeArchive('a.jsonl.archived', 1000);
    const b = makeArchive('b.jsonl.archived', 2000);
    const c = makeArchive('c.jsonl.archived', 3000);

    pruneArchives(tmpDir, 3);

    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
    expect(existsSync(c)).toBe(true);
  });

  it('does nothing when keepCount <= 0', () => {
    const a = makeArchive('a.jsonl.archived', 1000);
    const b = makeArchive('b.jsonl.archived', 2000);

    pruneArchives(tmpDir, 0);
    pruneArchives(tmpDir, -1);

    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  it('does not delete non-archive files in the same directory', () => {
    const archive = makeArchive('old.jsonl.archived', 1000);
    const otherArchive = makeArchive('newer.jsonl.archived', 2000);
    const active = join(tmpDir, 'active.jsonl');
    writeFileSync(active, 'active');
    const sibling = join(tmpDir, 'compaction-count.txt');
    writeFileSync(sibling, '5');

    pruneArchives(tmpDir, 1);

    // Only the older archive is removed.
    expect(existsSync(archive)).toBe(false);
    expect(existsSync(otherArchive)).toBe(true);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(sibling)).toBe(true);
  });

  it('returns silently when sessionDir does not exist', () => {
    expect(() => pruneArchives('/nonexistent/path/xyz-123', 5)).not.toThrow();
  });
});

describe('rotateSessionIfNeeded — archive pruning', () => {
  function seedSession(): void {
    const file = join(tmpDir, 'session.jsonl');
    writeJsonl(file, [
      sessionHeader(),
      messageEntry('e1', null, 'user'),
      messageEntry('e2', 'e1', 'assistant'),
      compactionEntry('c1', 'e2', 'e1'),
      messageEntry('e3', 'c1', 'user'),
    ]);
  }

  it('after 7 rotations with archive_keep_count=5, only 5 archives remain (newest kept)', () => {
    // Simulate 7 rotations; each call rotates the active jsonl into a new .archived file.
    const archivedPaths: string[] = [];
    for (let i = 0; i < 7; i++) {
      seedSession();
      const rotated = rotateSessionIfNeeded(tmpDir, '/tmp', 0, 5);
      expect(rotated).toBe(true);
      // Stamp the resulting archive's mtime so the keep-newest-by-mtime ordering is deterministic
      // (multiple rotations within a single ms could otherwise collide on the filesystem).
      const file = join(tmpDir, 'session.jsonl');
      const archivedPath = `${file}.archived`;
      const mtime = new Date((i + 1) * 1000);
      utimesSync(archivedPath, mtime, mtime);
      // Rename so the next iteration's `session.jsonl` rotates cleanly without colliding with
      // the freshly-created `session.jsonl.archived` from the previous iteration.
      const renamed = join(tmpDir, `archive-${i}.jsonl.archived`);
      renameSync(archivedPath, renamed);
      utimesSync(renamed, mtime, mtime);
      archivedPaths.push(renamed);

      // Remove the freshly written `session.jsonl` (the new active file generated by rotation
      // is named with a timestamp+uuid, not `session.jsonl`). Clean any *.jsonl files the
      // rotator emitted so the next iteration's seedSession can reuse `session.jsonl`.
      const remainingJsonl = readdirSync(tmpDir).filter(
        (f) => f.endsWith('.jsonl') && !f.endsWith('.archived')
      );
      for (const r of remainingJsonl) {
        unlinkSync(join(tmpDir, r));
      }
    }

    // After 7 rotations + prune-on-each-rotation cap of 5: 5 archives remain.
    const archives = readdirSync(tmpDir).filter((f) => f.endsWith('.jsonl.archived'));
    expect(archives.length).toBe(5);

    // The 5 remaining must be the 5 newest by mtime — the last 5 we created (i=2..6).
    const remainingPaths = archives.map((f) => join(tmpDir, f)).sort();
    const expectedKept = archivedPaths.slice(2).sort();
    expect(remainingPaths).toEqual(expectedKept);
  });

  it('bare-bytes-tail rotation also prunes archives', () => {
    // Pre-seed 6 stale archives with old mtimes so the prune step has work to do.
    for (let i = 0; i < 6; i++) {
      const path = join(tmpDir, `stale-${i}.jsonl.archived`);
      writeFileSync(path, 'old');
      utimesSync(path, new Date(1000 + i), new Date(1000 + i));
    }

    // Build a session with no compaction so rotation goes through the bare-bytes-tail path.
    const file = join(tmpDir, 'session.jsonl');
    const entries: object[] = [sessionHeader()];
    for (let i = 0; i < 8; i++) {
      const prev = i === 0 ? null : `e${i - 1}`;
      entries.push(messageEntry(`e${i}`, prev, i % 2 === 0 ? 'user' : 'assistant'));
    }
    writeJsonl(file, entries);

    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const rotated = rotateSessionIfNeeded(tmpDir, '/tmp', 0, 3);
    expect(rotated).toBe(true);
    warnSpy.mockRestore();

    // Bare-bytes-tail rotation creates one new archive; with cap=3 and 6 stale + 1 new = 7
    // archives, the 4 oldest must be pruned, leaving exactly 3.
    const archives = readdirSync(tmpDir).filter((f) => f.endsWith('.jsonl.archived'));
    expect(archives.length).toBe(3);
    // The newly rotated archive (session.jsonl.archived, written just now) must be among the
    // 3 newest by mtime and therefore preserved.
    expect(archives).toContain('session.jsonl.archived');
  });
});
