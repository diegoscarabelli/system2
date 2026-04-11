import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveProjectDir } from './dir.js';

describe('resolveProjectDir', () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'system2-test-'));
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it('creates a new folder when none exists', () => {
    const result = resolveProjectDir(projectsDir, 1, 'My Project');
    expect(result).toBe(join(projectsDir, '1_my-project'));
    expect(existsSync(result)).toBe(true);
    expect(existsSync(join(result, 'artifacts'))).toBe(true);
    expect(existsSync(join(result, 'scratchpad'))).toBe(true);
  });

  it('returns existing folder when slug matches and ensures subdirs', () => {
    mkdirSync(join(projectsDir, '1_my-project'));
    const result = resolveProjectDir(projectsDir, 1, 'My Project');
    expect(result).toBe(join(projectsDir, '1_my-project'));
    expect(existsSync(join(result, 'artifacts'))).toBe(true);
    expect(existsSync(join(result, 'scratchpad'))).toBe(true);
  });

  it('renames folder when project title changed', () => {
    const oldDir = join(projectsDir, '1_old-name');
    mkdirSync(oldDir);
    writeFileSync(join(oldDir, 'log.md'), 'some content');

    const result = resolveProjectDir(projectsDir, 1, 'New Name');
    expect(result).toBe(join(projectsDir, '1_new-name'));
    expect(existsSync(join(projectsDir, '1_new-name', 'log.md'))).toBe(true);
    expect(existsSync(oldDir)).toBe(false);
  });

  it('renames the most recent folder when multiple exist', () => {
    // Create two folders for the same project ID (the bug scenario)
    const older = join(projectsDir, '1_first-name');
    const newer = join(projectsDir, '1_second-name');
    mkdirSync(older);
    writeFileSync(join(older, 'old-file.txt'), 'old');
    // Force older mtime so ordering is deterministic
    const past = new Date(Date.now() - 10_000);
    utimesSync(older, past, past);
    mkdirSync(newer);
    writeFileSync(join(newer, 'new-file.txt'), 'new');

    const result = resolveProjectDir(projectsDir, 1, 'Final Name');
    expect(result).toBe(join(projectsDir, '1_final-name'));
    // Most recent folder (1_second-name) was renamed, older one left as-is
    expect(existsSync(join(projectsDir, '1_final-name', 'new-file.txt'))).toBe(true);
    expect(existsSync(older)).toBe(true);
  });

  it('does not touch folders belonging to other project IDs', () => {
    mkdirSync(join(projectsDir, '2_other-project'));
    const result = resolveProjectDir(projectsDir, 1, 'My Project');
    expect(result).toBe(join(projectsDir, '1_my-project'));
    expect(existsSync(join(projectsDir, '2_other-project'))).toBe(true);
  });

  it('creates projectsDir when it does not exist', () => {
    const nested = join(projectsDir, 'sub', 'projects');
    const result = resolveProjectDir(nested, 1, 'Deep Project');
    expect(result).toBe(join(nested, '1_deep-project'));
    expect(existsSync(result)).toBe(true);
  });

  it('patches stale project_name in log.md frontmatter after rename', () => {
    const oldDir = join(projectsDir, '1_old-name');
    mkdirSync(oldDir);
    writeFileSync(
      join(oldDir, 'log.md'),
      '---\nlast_narrator_update_ts: 2026-03-20T00:00:00Z\nproject_id: 1\nproject_name: Old Name\n---\n## Entry\nSome log content\n'
    );

    resolveProjectDir(projectsDir, 1, 'New Name');

    const content = readFileSync(join(projectsDir, '1_new-name', 'log.md'), 'utf-8');
    expect(content).toContain('project_name: New Name');
    expect(content).toContain('project_id: 1');
    expect(content).toContain('Some log content');
  });

  it('slugifies special characters correctly', () => {
    const result = resolveProjectDir(projectsDir, 3, 'Medicaid Fraud Anomaly Detection (CA)');
    expect(result).toBe(join(projectsDir, '3_medicaid-fraud-anomaly-detection-ca'));
  });
});
