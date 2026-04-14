/**
 * Log Rotation Utility
 *
 * Rotates log files when they exceed a size threshold.
 */

import { existsSync, renameSync, statSync, unlinkSync } from 'node:fs';

export interface LogRotationOptions {
  logFile: string;
  maxSizeMB?: number;
  maxFiles?: number;
}

/**
 * Rotate log file if it exceeds max size
 *
 * Example:
 *   system2.log (15 MB) →
 *     system2.log.3 → system2.log.4 (or deleted if > maxFiles)
 *     system2.log.2 → system2.log.3
 *     system2.log.1 → system2.log.2
 *     system2.log   → system2.log.1
 *     (new system2.log created)
 */
export function rotateLogIfNeeded(options: LogRotationOptions): void {
  const { logFile, maxSizeMB = 10, maxFiles = 5 } = options;

  if (!existsSync(logFile)) {
    return; // No log file to rotate
  }

  const stats = statSync(logFile);
  const sizeInMB = stats.size / 1024 / 1024;

  if (sizeInMB < maxSizeMB) {
    return; // File is small enough, no rotation needed
  }

  console.log(`Rotating log file (${sizeInMB.toFixed(2)} MB)...`);

  // Delete oldest log if we've hit the limit
  const oldestLog = `${logFile}.${maxFiles}`;
  if (existsSync(oldestLog)) {
    unlinkSync(oldestLog);
  }

  // Shift existing rotated logs
  for (let i = maxFiles - 1; i >= 1; i--) {
    const currentLog = `${logFile}.${i}`;
    const nextLog = `${logFile}.${i + 1}`;
    if (existsSync(currentLog)) {
      renameSync(currentLog, nextLog);
    }
  }

  // Rotate current log to .1
  renameSync(logFile, `${logFile}.1`);

  console.log(`✓ Log rotated (keeping last ${maxFiles} files)`);
}
