import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../db/client.js';
import { createShowArtifactTool } from './show-artifact.js';

const TEST_DIR = join(tmpdir(), 'system2-show-artifact-test');

function mockDb(artifact: Record<string, unknown> | null = null): DatabaseClient {
  return {
    getArtifactByPath: () => artifact,
  } as unknown as DatabaseClient;
}

// Derive types from the tool so tests stay in sync with implementation
const _refTool = createShowArtifactTool(mockDb());
type ShowArtifactParams = Parameters<typeof _refTool.execute>[1];
type ShowArtifactResult = Awaited<ReturnType<typeof _refTool.execute>>;

describe('show_artifact tool', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns artifact URL for existing file', async () => {
    const filename = `test-artifact-${randomUUID().slice(0, 8)}.html`;
    const absPath = join(TEST_DIR, filename);
    writeFileSync(absPath, '<html></html>');

    const tool = createShowArtifactTool(mockDb());
    const exec = (params: Record<string, unknown>): Promise<ShowArtifactResult> =>
      tool.execute('test-call', params as ShowArtifactParams);
    const result = await exec({ file_path: absPath });

    expect((result.content[0] as { text: string }).text).toBe('Artifact displayed');
    expect((result.details as { url: string }).url).toContain('/api/artifact?path=');
    expect((result.details as { absolutePath: string }).absolutePath).toBe(absPath);
    expect((result.details as { title: string }).title).toBe(filename);
  });

  it('returns error for nonexistent file', async () => {
    const tool = createShowArtifactTool(mockDb());
    const exec = (params: Record<string, unknown>): Promise<ShowArtifactResult> =>
      tool.execute('test-call', params as ShowArtifactParams);
    const result = await exec({ file_path: `/tmp/nonexistent-${randomUUID()}.html` });

    expect((result.content[0] as { text: string }).text).toContain('not found');
    expect((result.details as { error: string }).error).toBe('not_found');
  });

  it('uses DB title when artifact is registered', async () => {
    const filename = `test-artifact-${randomUUID().slice(0, 8)}.html`;
    const absPath = join(TEST_DIR, filename);
    writeFileSync(absPath, '<html></html>');

    const tool = createShowArtifactTool(mockDb({ title: 'My Dashboard', file_path: absPath }));
    const exec = (params: Record<string, unknown>): Promise<ShowArtifactResult> =>
      tool.execute('test-call', params as ShowArtifactParams);
    const result = await exec({ file_path: absPath });

    expect((result.content[0] as { text: string }).text).toBe('Artifact displayed');
    expect((result.details as { title: string }).title).toBe('My Dashboard');
  });

  it('supports ~/ path expansion', async () => {
    const filename = `test-artifact-${randomUUID().slice(0, 8)}.html`;
    const absPath = join(homedir(), filename);
    writeFileSync(absPath, '<html></html>');

    try {
      const tool = createShowArtifactTool(mockDb());
      const exec = (params: Record<string, unknown>): Promise<ShowArtifactResult> =>
        tool.execute('test-call', params as ShowArtifactParams);
      const result = await exec({ file_path: `~/${filename}` });

      expect((result.content[0] as { text: string }).text).toBe('Artifact displayed');
      expect((result.details as { absolutePath: string }).absolutePath).toBe(absPath);
    } finally {
      rmSync(absPath, { force: true });
    }
  });

  it('returns error for relative path', async () => {
    const tool = createShowArtifactTool(mockDb());
    const exec = (params: Record<string, unknown>): Promise<ShowArtifactResult> =>
      tool.execute('test-call', params as ShowArtifactParams);
    const result = await exec({ file_path: 'relative/path.html' });

    expect((result.content[0] as { text: string }).text).toContain('must be absolute');
    expect((result.details as { error: string }).error).toBe('invalid_path');
  });

  it('shows search hint for registered artifact with missing file', async () => {
    const tool = createShowArtifactTool(
      mockDb({ title: 'Lost Report', file_path: '/tmp/gone.html' })
    );
    const exec = (params: Record<string, unknown>): Promise<ShowArtifactResult> =>
      tool.execute('test-call', params as ShowArtifactParams);
    const result = await exec({ file_path: '/tmp/gone.html' });

    expect((result.content[0] as { text: string }).text).toContain('Lost Report');
    expect((result.content[0] as { text: string }).text).toContain('moved');
    expect((result.details as { error: string }).error).toBe('not_found');
  });
});
