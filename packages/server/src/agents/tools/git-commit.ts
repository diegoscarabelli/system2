/**
 * Git Commit Helper
 *
 * Shared by write and edit tools to auto-commit files in the
 * System2 state directory (~/.system2/) when a commit_message is provided.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * If filePath is inside ~/.system2/ and a git repo exists there,
 * stage and commit the file. Non-fatal on failure.
 */
export function commitIfStateDir(filePath: string, message: string): void {
  const system2Dir = join(homedir(), '.system2');
  if (!filePath.startsWith(system2Dir) || !existsSync(join(system2Dir, '.git'))) {
    return;
  }

  try {
    execSync(
      `git add ${JSON.stringify(filePath)} && git diff --cached --quiet || git commit -m ${JSON.stringify(message)}`,
      { cwd: system2Dir, stdio: 'ignore', timeout: 10000 }
    );
  } catch {
    // Git commit failure is non-fatal — the file operation already succeeded
  }
}
