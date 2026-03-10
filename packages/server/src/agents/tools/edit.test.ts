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

describe('edit tool', () => {
  const tool = createEditTool();
  const exec = (params: Record<string, unknown>, signal?: AbortSignal) =>
    tool.execute('test-call', params as any, signal);

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('replaces a unique string', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'test.txt');
    writeFileSync(file, 'line one\nline two\nline three\n');

    const result = await exec({ path: file, old_string: 'line two', new_string: 'line TWO' });

    expect(result.content[0].text).toContain('Edited');
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

    expect(result.content[0].text).toContain('Edited');
    expect(readFileSync(file, 'utf-8')).toBe('header\nnew middle line\nfooter\n');
  });

  it('errors when old_string not found', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'test.txt');
    writeFileSync(file, 'some content');

    const result = await exec({ path: file, old_string: 'nonexistent', new_string: 'x' });

    expect(result.content[0].text).toContain('not found');
    expect(result.details).toHaveProperty('error', 'not_found');
  });

  it('errors when old_string appears multiple times', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'test.txt');
    writeFileSync(file, 'aaa\nbbb\naaa\n');

    const result = await exec({ path: file, old_string: 'aaa', new_string: 'ccc' });

    expect(result.content[0].text).toContain('2 times');
    expect(result.details).toHaveProperty('error', 'not_unique');
  });

  it('errors when old_string equals new_string', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'test.txt');
    writeFileSync(file, 'content');

    const result = await exec({ path: file, old_string: 'content', new_string: 'content' });

    expect(result.content[0].text).toContain('identical');
    expect(result.details).toHaveProperty('error', 'identical_strings');
  });

  it('errors when file does not exist', async () => {
    const result = await exec({
      path: `/tmp/nonexistent-file-${randomUUID()}`,
      old_string: 'x',
      new_string: 'y',
    });

    expect(result.content[0].text).toContain('File not found');
  });

  it('returns aborted when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await exec(
      { path: '/tmp/whatever', old_string: 'x', new_string: 'y' },
      controller.signal
    );

    expect(result.content[0].text).toBe('Edit aborted.');
    expect(result.details).toHaveProperty('error', 'aborted');
  });
});
