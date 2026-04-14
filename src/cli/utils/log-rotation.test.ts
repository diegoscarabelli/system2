import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rotateLogIfNeeded } from './log-rotation.js';

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

describe('rotateLogIfNeeded', () => {
  it('does nothing when log file does not exist', () => {
    const dir = trackTmpDir(makeTmpDir());
    rotateLogIfNeeded({ logFile: join(dir, 'missing.log') });
    // Should not throw
  });

  it('does nothing when file is below threshold', () => {
    const dir = trackTmpDir(makeTmpDir());
    const logFile = join(dir, 'app.log');
    writeFileSync(logFile, 'small content');
    rotateLogIfNeeded({ logFile, maxSizeMB: 10 });
    expect(existsSync(logFile)).toBe(true);
    expect(existsSync(`${logFile}.1`)).toBe(false);
  });

  it('rotates log when file exceeds threshold', () => {
    const dir = trackTmpDir(makeTmpDir());
    const logFile = join(dir, 'app.log');
    // Write content just over 1KB (using 1KB as threshold for testing)
    const content = 'x'.repeat(2000);
    writeFileSync(logFile, content);

    rotateLogIfNeeded({ logFile, maxSizeMB: 0.001 }); // ~1KB threshold

    expect(existsSync(`${logFile}.1`)).toBe(true);
    expect(readFileSync(`${logFile}.1`, 'utf-8')).toBe(content);
    expect(existsSync(logFile)).toBe(false); // Original moved
  });

  it('shifts existing rotated logs', () => {
    const dir = trackTmpDir(makeTmpDir());
    const logFile = join(dir, 'app.log');

    // Create existing rotated files
    writeFileSync(`${logFile}.1`, 'first rotation');
    writeFileSync(`${logFile}.2`, 'second rotation');

    // Create oversized current log
    writeFileSync(logFile, 'x'.repeat(2000));
    rotateLogIfNeeded({ logFile, maxSizeMB: 0.001 });

    expect(readFileSync(`${logFile}.3`, 'utf-8')).toBe('second rotation');
    expect(readFileSync(`${logFile}.2`, 'utf-8')).toBe('first rotation');
    expect(existsSync(`${logFile}.1`)).toBe(true);
  });

  it('deletes oldest log when maxFiles reached', () => {
    const dir = trackTmpDir(makeTmpDir());
    const logFile = join(dir, 'app.log');

    // Create maxFiles worth of rotated logs
    writeFileSync(`${logFile}.1`, 'rot1');
    writeFileSync(`${logFile}.2`, 'rot2');
    writeFileSync(`${logFile}.3`, 'rot3');

    // Create oversized current log
    writeFileSync(logFile, 'x'.repeat(2000));
    rotateLogIfNeeded({ logFile, maxSizeMB: 0.001, maxFiles: 3 });

    // .3 (oldest at max) should have been deleted, then .2->.3, .1->.2, log->.1
    expect(existsSync(`${logFile}.1`)).toBe(true);
    expect(existsSync(`${logFile}.2`)).toBe(true);
    expect(existsSync(`${logFile}.3`)).toBe(true);
    // Only 3 rotated files should exist
    expect(existsSync(`${logFile}.4`)).toBe(false);
  });
});
