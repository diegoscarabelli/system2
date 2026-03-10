import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReadTool } from './read.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `system2-test-read-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tmpDirs: string[] = [];
function trackDir(dir: string): string {
  tmpDirs.push(dir);
  return dir;
}

describe('read tool', () => {
  const tool = createReadTool();
  const exec = (params: Record<string, unknown>) => tool.execute('test-call', params as any) as any;

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('reads an existing file', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'test.txt');
    writeFileSync(file, 'hello world');

    const result = await exec({ path: file });

    expect(result.content[0].text).toBe('hello world');
    expect(result.details).toHaveProperty('size', 11);
  });

  it('returns error for nonexistent file', async () => {
    const result = await exec({ path: `/tmp/nonexistent-${randomUUID()}` });

    expect(result.content[0].text).toContain('File not found');
  });
});
