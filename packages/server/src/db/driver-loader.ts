/**
 * Dynamic Driver Loader
 *
 * Loads database driver packages from ~/.system2/node_modules/ at runtime.
 * Drivers are installed by the Guide agent during onboarding, not bundled with System2.
 */

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SYSTEM2_DIR = join(homedir(), '.system2');

export function loadDriver(packageName: string): unknown {
  try {
    const localRequire = createRequire(join(SYSTEM2_DIR, 'package.json'));
    return localRequire(packageName);
  } catch {
    throw new Error(
      `Database driver "${packageName}" is not installed. ` +
        `Ask the Guide to set it up, or run: npm install --prefix ${SYSTEM2_DIR} ${packageName}`
    );
  }
}
