import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWriteTool } from './write.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `system2-test-write-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tmpDirs: string[] = [];
function trackDir(dir: string): string {
  tmpDirs.push(dir);
  return dir;
}

// Derive types from the tool so tests stay in sync with implementation
const _refTool = createWriteTool();
type WriteParams = Parameters<typeof _refTool.execute>[1];

describe('write tool', () => {
  const tool = createWriteTool();
  const exec = (params: Record<string, unknown>) =>
    tool.execute('test-call', params as WriteParams);

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('creates a new file', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'new.txt');

    const result = await exec({ path: file, content: 'new content' });

    expect(result.content[0].text).toContain('Successfully wrote');
    expect(readFileSync(file, 'utf-8')).toBe('new content');
  });

  it('creates parent directories', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'deep', 'nested', 'file.txt');

    await exec({ path: file, content: 'nested' });

    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe('nested');
  });

  it('overwrites an existing file', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'existing.txt');
    writeFileSync(file, 'old content');

    await exec({ path: file, content: 'new content' });

    expect(readFileSync(file, 'utf-8')).toBe('new content');
  });
});
