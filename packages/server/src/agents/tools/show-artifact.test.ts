import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createShowArtifactTool } from './show-artifact.js';

const SYSTEM2_DIR = join(homedir(), '.system2');

describe('show_artifact tool', () => {
  const tool = createShowArtifactTool();
  const exec = (params: Record<string, unknown>) => tool.execute('test-call', params as any);

  const createdFiles: string[] = [];

  afterEach(() => {
    for (const f of createdFiles) rmSync(f, { force: true });
    createdFiles.length = 0;
  });

  it('returns artifact URL for existing file', async () => {
    const relPath = `test-artifact-${randomUUID().slice(0, 8)}.html`;
    const absPath = join(SYSTEM2_DIR, relPath);
    mkdirSync(SYSTEM2_DIR, { recursive: true });
    writeFileSync(absPath, '<html></html>');
    createdFiles.push(absPath);

    const result = await exec({ path: relPath });

    expect(result.content[0].text).toBe('Artifact displayed');
    expect((result.details as any).url).toBe(`/artifacts/${relPath}`);
  });

  it('returns error for nonexistent file', async () => {
    const result = await exec({ path: `nonexistent-${randomUUID()}.html` });

    expect(result.content[0].text).toContain('not found');
    expect((result.details as any).error).toBe('not_found');
  });
});
