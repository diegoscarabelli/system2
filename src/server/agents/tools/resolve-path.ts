/**
 * Path Resolution Helper
 *
 * Shared by file tools (read, write, edit, show-artifact) to expand
 * home directory references and resolve relative paths.
 */

import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

/** Returns true if `inputPath` starts with `~/`, `~\`, or is exactly `~`. */
export function isTildePath(inputPath: string): boolean {
  return inputPath === '~' || inputPath.startsWith('~/') || inputPath.startsWith(`~${sep}`);
}

/**
 * Expand `~/` (or `~\` on Windows) and resolve relative paths against
 * the user's home directory. Absolute paths are returned as-is.
 */
export function resolvePath(inputPath: string): string {
  if (inputPath === '~') return homedir();
  const expanded = isTildePath(inputPath) ? inputPath.slice(2) : inputPath;
  return isAbsolute(expanded) ? expanded : resolve(homedir(), expanded);
}
