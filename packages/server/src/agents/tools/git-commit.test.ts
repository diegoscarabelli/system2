import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock homedir() so commitIfStateDir targets our temp directory
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: vi.fn() };
});

import { homedir } from 'node:os';
import { commitIfStateDir } from './git-commit.js';

const mockHomedir = vi.mocked(homedir);

describe('commitIfStateDir', () => {
  let fakeHome: string;
  let system2Dir: string;

  beforeEach(() => {
    fakeHome = join(
      tmpdir(),
      `git-commit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    system2Dir = join(fakeHome, '.system2');
    mkdirSync(join(system2Dir, 'knowledge'), { recursive: true });
    mockHomedir.mockReturnValue(fakeHome);
  });

  afterEach(() => {
    if (existsSync(fakeHome)) {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // Strip GIT_DIR / GIT_WORK_TREE so test helpers target the temp repo,
  // not the code repo (git hooks set these in the environment).
  function gitEnv() {
    const { GIT_DIR, GIT_WORK_TREE, ...clean } = process.env;
    return clean;
  }

  function initGitRepo(dir: string): void {
    const opts = { cwd: dir, env: gitEnv(), stdio: 'ignore' as const };
    execSync('git init', opts);
    execSync('git config user.email "test@test.com"', opts);
    execSync('git config user.name "Test"', opts);
    execSync('git commit --allow-empty -m "init"', opts);
  }

  function commitCount(dir: string): number {
    return Number(
      execSync('git rev-list --all --count', { cwd: dir, env: gitEnv(), encoding: 'utf-8' }).trim()
    );
  }

  it('skips when filePath is outside ~/.system2/', () => {
    initGitRepo(system2Dir);
    const outsidePath = join(fakeHome, 'other', 'file.md');
    mkdirSync(join(fakeHome, 'other'), { recursive: true });
    writeFileSync(outsidePath, 'data');

    commitIfStateDir(outsidePath, 'should not commit');

    expect(commitCount(system2Dir)).toBe(1); // only the init commit
  });

  it('skips when ~/.system2/.git does not exist', () => {
    // No git init — .git doesn't exist
    const filePath = join(system2Dir, 'knowledge', 'test.md');
    writeFileSync(filePath, 'data');

    commitIfStateDir(filePath, 'should not commit');

    expect(existsSync(join(system2Dir, '.git'))).toBe(false);
  });

  it('commits to ~/.system2 repo when path is valid', () => {
    initGitRepo(system2Dir);
    const filePath = join(system2Dir, 'knowledge', 'infra.md');
    writeFileSync(filePath, 'infrastructure data');

    commitIfStateDir(filePath, 'cursor: infra.md');

    expect(commitCount(system2Dir)).toBe(2); // init + our commit
    const lastMsg = execSync('git log -1 --format=%s', {
      cwd: system2Dir,
      env: gitEnv(),
      encoding: 'utf-8',
    }).trim();
    expect(lastMsg).toBe('cursor: infra.md');
  });

  it('does not commit to the code repo even when run from it', () => {
    initGitRepo(system2Dir);

    // Count commits in the actual code repo before
    const codeRepoRoot = execSync('git rev-parse --show-toplevel', {
      env: gitEnv(),
      encoding: 'utf-8',
    }).trim();
    const beforeCount = commitCount(codeRepoRoot);

    const filePath = join(system2Dir, 'knowledge', 'test.md');
    writeFileSync(filePath, 'should only go to system2 repo');
    commitIfStateDir(filePath, 'cursor: test.md');

    // Code repo commit count must not change
    expect(commitCount(codeRepoRoot)).toBe(beforeCount);
    // system2 repo must have the new commit
    expect(commitCount(system2Dir)).toBe(2);
  });

  it('is a no-op when file has no changes', () => {
    initGitRepo(system2Dir);
    const filePath = join(system2Dir, 'knowledge', 'stable.md');
    writeFileSync(filePath, 'unchanged');

    // First commit
    commitIfStateDir(filePath, 'first');
    expect(commitCount(system2Dir)).toBe(2);

    // Second call with same content — should not create a new commit
    commitIfStateDir(filePath, 'second');
    expect(commitCount(system2Dir)).toBe(2);
  });
});
