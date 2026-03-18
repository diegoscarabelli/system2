import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEditTool } from './edit.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `system2-test-edit-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tmpDirs: string[] = [];
function trackDir(dir: string): string {
  tmpDirs.push(dir);
  return dir;
}

// Derive types from the tool so tests stay in sync with implementation
const _refTool = createEditTool();
type EditParams = Parameters<typeof _refTool.execute>[1];

describe('edit tool', () => {
  const tool = createEditTool();
  const exec = (params: Record<string, unknown>, signal?: AbortSignal) =>
    tool.execute('test-call', params as EditParams, signal);

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('replaces a unique string', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'test.txt');
    writeFileSync(file, 'line one\nline two\nline three\n');

    const result = await exec({ path: file, old_string: 'line two', new_string: 'line TWO' });

    expect((result.content[0] as { text: string }).text).toContain('Edited');
    expect(readFileSync(file, 'utf-8')).toBe('line one\nline TWO\nline three\n');
  });

  it('handles insertion via context', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'test.txt');
    writeFileSync(file, 'header\nfooter\n');

    const result = await exec({
      path: file,
      old_string: 'header\nfooter',
      new_string: 'header\nnew middle line\nfooter',
    });

    expect((result.content[0] as { text: string }).text).toContain('Edited');
    expect(readFileSync(file, 'utf-8')).toBe('header\nnew middle line\nfooter\n');
  });

  it('errors when old_string not found', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'test.txt');
    writeFileSync(file, 'some content');

    const result = await exec({ path: file, old_string: 'nonexistent', new_string: 'x' });

    expect((result.content[0] as { text: string }).text).toContain('not found');
    expect(result.details).toHaveProperty('error', 'not_found');
  });

  it('errors when old_string appears multiple times', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'test.txt');
    writeFileSync(file, 'aaa\nbbb\naaa\n');

    const result = await exec({ path: file, old_string: 'aaa', new_string: 'ccc' });

    expect((result.content[0] as { text: string }).text).toContain('2 times');
    expect(result.details).toHaveProperty('error', 'not_unique');
  });

  it('errors when old_string equals new_string', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'test.txt');
    writeFileSync(file, 'content');

    const result = await exec({ path: file, old_string: 'content', new_string: 'content' });

    expect((result.content[0] as { text: string }).text).toContain('identical');
    expect(result.details).toHaveProperty('error', 'identical_strings');
  });

  it('errors when file does not exist', async () => {
    const result = await exec({
      path: `/tmp/nonexistent-file-${randomUUID()}`,
      old_string: 'x',
      new_string: 'y',
    });

    expect((result.content[0] as { text: string }).text).toContain('File not found');
  });

  it('returns aborted when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await exec(
      { path: '/tmp/whatever', old_string: 'x', new_string: 'y' },
      controller.signal
    );

    expect((result.content[0] as { text: string }).text).toBe('Edit aborted.');
    expect(result.details).toHaveProperty('error', 'aborted');
  });

  it('errors when old_string is missing and append is not set', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'test.txt');
    writeFileSync(file, 'content');

    const result = await exec({ path: file, new_string: 'x' });

    expect((result.content[0] as { text: string }).text).toContain('old_string');
    expect(result.details).toHaveProperty('error', 'missing_old_string');
  });

  describe('append mode', () => {
    it('appends to an existing file with trailing newline', async () => {
      const dir = trackDir(makeTmpDir());
      const file = join(dir, 'test.txt');
      writeFileSync(file, 'existing content\n');

      const result = await exec({ path: file, new_string: 'new line\n', append: true });

      expect((result.content[0] as { text: string }).text).toContain('Appended');
      expect(readFileSync(file, 'utf-8')).toBe('existing content\nnew line\n');
    });

    it('adds newline separator when existing content lacks trailing newline', async () => {
      const dir = trackDir(makeTmpDir());
      const file = join(dir, 'test.txt');
      writeFileSync(file, 'existing content');

      await exec({ path: file, new_string: 'new line', append: true });

      expect(readFileSync(file, 'utf-8')).toBe('existing content\nnew line');
    });

    it('appends to an empty file without adding a separator', async () => {
      const dir = trackDir(makeTmpDir());
      const file = join(dir, 'test.txt');
      writeFileSync(file, '');

      await exec({ path: file, new_string: 'content', append: true });

      expect(readFileSync(file, 'utf-8')).toBe('content');
    });

    it('creates file and parent directories if they do not exist', async () => {
      const dir = trackDir(makeTmpDir());
      const file = join(dir, 'subdir', 'nested', 'test.txt');

      const result = await exec({ path: file, new_string: 'hello', append: true });

      expect((result.content[0] as { text: string }).text).toContain('Appended');
      expect(readFileSync(file, 'utf-8')).toBe('hello');
    });

    it('does not double newline when new_string starts with newline', async () => {
      const dir = trackDir(makeTmpDir());
      const file = join(dir, 'test.txt');
      writeFileSync(file, 'existing content');

      await exec({ path: file, new_string: '\nnew line', append: true });

      expect(readFileSync(file, 'utf-8')).toBe('existing content\nnew line');
    });

    it('reports correct line count when new_string has trailing newline', async () => {
      const dir = trackDir(makeTmpDir());
      const file = join(dir, 'test.txt');
      writeFileSync(file, '');

      const result = await exec({ path: file, new_string: 'line one\nline two\n', append: true });

      expect((result.content[0] as { text: string }).text).toContain('2 line(s)');
    });

    it('does not double newline when new_string starts with CRLF', async () => {
      const dir = trackDir(makeTmpDir());
      const file = join(dir, 'test.txt');
      writeFileSync(file, 'existing content');

      await exec({ path: file, new_string: '\r\nnew line', append: true });

      expect(readFileSync(file, 'utf-8')).toBe('existing content\r\nnew line');
    });

    it('reports 0 lines appended when new_string is empty', async () => {
      const dir = trackDir(makeTmpDir());
      const file = join(dir, 'test.txt');
      writeFileSync(file, 'existing content');

      const result = await exec({ path: file, new_string: '', append: true });

      expect((result.content[0] as { text: string }).text).toContain('0 line(s)');
    });
  });
});
