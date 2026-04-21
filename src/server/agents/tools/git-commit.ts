/**
 * Git Commit Helper
 *
 * Shared by write and edit tools to auto-commit files in the
 * System2 state directory (~/.system2/) when a commit_message is provided.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

/**
 * If filePath is inside ~/.system2/ and a git repo exists there,
 * stage and commit the file. Non-fatal on failure.
 */
export function commitIfStateDir(filePath: string, message: string): void {
  const system2Dir = join(homedir(), '.system2');
  if (!filePath.startsWith(`${system2Dir}${sep}`) || !existsSync(join(system2Dir, '.git'))) {
    return;
  }

  // Strip GIT_DIR / GIT_WORK_TREE so git targets the ~/.system2 repo,
  // not whatever repo the parent process (dev server, git hook, etc.) uses.
  const { GIT_DIR, GIT_WORK_TREE, ...cleanEnv } = process.env;
  const execOpts = { cwd: system2Dir, env: cleanEnv, stdio: 'ignore' as const, timeout: 10000 };

  // Git accepts forward slashes on all platforms; avoid JSON.stringify
  // double-escaping backslashes when the path is passed through cmd.exe.
  const gitPath = filePath.replace(/\\/g, '/');

  try {
    execSync(`git add "${gitPath}"`, execOpts);
    execSync(`git diff --cached --quiet || git commit -m ${JSON.stringify(message)}`, execOpts);
  } catch {
    // Git commit failure is non-fatal — the file operation already succeeded
  }
}
