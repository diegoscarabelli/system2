/**
 * Git Repository Initialization for ~/.system2/
 *
 * Initializes a git repo in the System2 data directory for version-controlled
 * change tracking of knowledge files. Called during server startup (idempotent).
 */

import { execSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const GITIGNORE_CONTENT = `# Database (binary, use SQL timestamps for change detection)
app.db
app.db-shm
app.db-wal

# Runtime
server.pid
logs/
*.log

# Session files (large, binary-like JSONL)
sessions/
`;

/**
 * Initialize a git repository in the System2 data directory.
 * Skips if already initialized.
 */
export function initializeGitRepo(system2Dir: string): void {
  const gitDir = join(system2Dir, '.git');

  if (existsSync(gitDir)) {
    return;
  }

  // Verify git is available
  try {
    execSync('git --version', { stdio: 'ignore' });
  } catch {
    throw new Error(
      'git is required but not found. Install git and try again: https://git-scm.com/downloads'
    );
  }

  // Initialize repo
  execSync('git init', { cwd: system2Dir, stdio: 'ignore' });

  // Write .gitignore
  writeFileSync(join(system2Dir, '.gitignore'), GITIGNORE_CONTENT, 'utf-8');

  // Initial commit
  execSync('git add -A && git commit -m "Initial commit"', {
    cwd: system2Dir,
    stdio: 'ignore',
  });

  console.log('[Knowledge] Initialized git repository in', system2Dir);
}
