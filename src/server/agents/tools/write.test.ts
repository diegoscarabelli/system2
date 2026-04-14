import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWriteTool, isSensitivePath } from './write.js';

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

  it('writes to an existing empty file', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'empty.txt');
    writeFileSync(file, '');

    const result = await exec({ path: file, content: 'now has content' });

    expect((result.content[0] as { text: string }).text).toContain('Successfully wrote');
    expect(readFileSync(file, 'utf-8')).toBe('now has content');
  });

  it('blocks overwriting an existing file with content', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'existing.txt');
    writeFileSync(file, 'important existing content');

    const result = await exec({ path: file, content: 'replacement' });
    const text = (result.content[0] as { text: string }).text;

    // Should block the write
    expect(text).toContain('Cannot write: file already exists with content');
    expect(text).toContain('important existing content');
    expect(text).toContain('edit');
    expect(text).toContain('delete it first');
    // Original content should be preserved
    expect(readFileSync(file, 'utf-8')).toBe('important existing content');
  });

  it('includes file size in blocked overwrite message', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'sized.txt');
    writeFileSync(file, 'hello world');

    const result = await exec({ path: file, content: 'replacement' });
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain('11 bytes');
  });

  it('truncates long existing content in blocked overwrite preview', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'big.txt');
    const longContent = 'x'.repeat(500);
    writeFileSync(file, longContent);

    const result = await exec({ path: file, content: 'short' });
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain('500 bytes');
    expect(text).toContain('...');
    // Preview should be capped at PREVIEW_BYTES (200), not the full 500 chars
    const match = text.match(/x+/);
    expect(match).not.toBeNull();
    expect((match as RegExpMatchArray)[0].length).toBeLessThanOrEqual(200);
    // Original content should be preserved
    expect(readFileSync(file, 'utf-8')).toBe(longContent);
  });

  it('sets blocked flag in details when overwrite is prevented', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'flagged.txt');
    writeFileSync(file, 'content');

    const result = await exec({ path: file, content: 'replacement' });

    expect((result.details as Record<string, unknown>).blocked).toBe(true);
  });

  describe('isSensitivePath', () => {
    it('returns true for files inside ~/.system2/', () => {
      expect(isSensitivePath(join(homedir(), '.system2', 'config.toml'))).toBe(true);
      expect(isSensitivePath(join(homedir(), '.system2', 'nested', 'file.txt'))).toBe(true);
    });

    it('returns false for files outside ~/.system2/', () => {
      expect(isSensitivePath(join(tmpdir(), 'file.txt'))).toBe(false);
      expect(isSensitivePath(join(homedir(), 'projects', 'config.toml'))).toBe(false);
      expect(isSensitivePath(join(homedir(), '.system2-other', 'file.txt'))).toBe(false);
    });
  });

  it('omits content preview for files in ~/.system2/', async () => {
    // Create a temp file inside ~/.system2/ — the actual state directory — to
    // avoid mocking node:os. The file is cleaned up in afterEach.
    const stateDir = join(homedir(), '.system2');
    mkdirSync(stateDir, { recursive: true });
    const file = join(stateDir, `test-write-sensitive-${randomUUID().slice(0, 8)}.txt`);
    const secretContent = 'key = "sk-ant-secret-value"';
    writeFileSync(file, secretContent);
    tmpDirs.push(file); // cleaned up by afterEach via rmSync

    const result = await exec({ path: file, content: 'replacement' });
    const text = (result.content[0] as { text: string }).text;

    // Should still be blocked and report size
    expect(text).toContain('Cannot write: file already exists with content');
    // Should NOT include content preview to avoid leaking secrets
    expect(text).not.toContain(secretContent);
    expect(text).not.toContain('Existing content starts with');
    // Original content should be preserved
    expect(readFileSync(file, 'utf-8')).toBe(secretContent);
  });
});
