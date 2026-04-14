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

    expect((result.content[0] as { text: string }).text).toContain('Successfully wrote');
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

  it('warns when overwriting an existing file with content', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'existing.txt');
    writeFileSync(file, 'important existing content');

    const result = await exec({ path: file, content: 'replacement' });
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain('WARNING: Overwrote existing file');
    expect(text).toContain('important existing content');
    expect(text).toContain('Use the `edit` tool');
  });

  it('does not warn when creating a new file', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'brand-new.txt');

    const result = await exec({ path: file, content: 'fresh' });
    const text = (result.content[0] as { text: string }).text;

    expect(text).not.toContain('WARNING');
  });

  it('truncates long existing content in overwrite warning', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'big.txt');
    const longContent = 'x'.repeat(500);
    writeFileSync(file, longContent);

    const result = await exec({ path: file, content: 'short' });
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain('WARNING: Overwrote existing file (500 bytes)');
    expect(text).toContain('...');
    // Preview should be truncated, not the full 500 chars
    expect(text.indexOf('x'.repeat(201))).toBe(-1);
  });
});
