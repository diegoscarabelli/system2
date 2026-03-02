/**
 * Automatic Backup Utility
 *
 * Creates daily backups of ~/.system2 on startup.
 * Only manages backups with a specific naming pattern to avoid
 * accidentally deleting user-created backup folders.
 *
 * Configuration via ~/.system2/config.toml:
 * - backup.cooldown_hours: Hours between backups (default: 24)
 * - backup.max_backups: Number of backups to keep (default: 5)
 */

import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';

const SYSTEM2_DIR = join(homedir(), '.system2');
const HOME_DIR = homedir();

// Pattern: .system2-auto-backup-YYYY-MM-DDTHH-MM-SS
const BACKUP_PREFIX = '.system2-auto-backup-';
const BACKUP_PATTERN = /^\.system2-auto-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

/**
 * Generate backup folder name with current timestamp.
 */
function generateBackupName(): string {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  return `${BACKUP_PREFIX}${timestamp}`;
}

/**
 * Find all automatic backup folders (matching our pattern only).
 * Returns sorted by name descending (newest first).
 */
function findAutoBackups(): string[] {
  const entries = readdirSync(HOME_DIR);
  return entries
    .filter((name) => BACKUP_PATTERN.test(name))
    .sort()
    .reverse();
}

/**
 * Get the timestamp of the most recent automatic backup.
 * Returns null if no backups exist.
 */
function getMostRecentBackupTime(): Date | null {
  const backups = findAutoBackups();
  if (backups.length === 0) return null;

  // Extract timestamp from folder name
  const mostRecent = backups[0];
  const timestampStr = mostRecent.replace(BACKUP_PREFIX, '').replace(/-/g, ':');
  // Convert back: 2026-03-02T14:30:00
  const isoStr = `${timestampStr.slice(0, 10)}T${timestampStr.slice(11).replace(/:/g, ':')}`;

  try {
    return new Date(isoStr.replace(/:(\d{2}):(\d{2})$/, ':$1:$2'));
  } catch {
    // If parsing fails, check folder mtime
    const backupPath = join(HOME_DIR, mostRecent);
    return statSync(backupPath).mtime;
  }
}

/**
 * Delete old backups beyond the retention limit.
 * Only deletes folders matching our specific pattern.
 */
function cleanupOldBackups(maxBackups: number): void {
  const backups = findAutoBackups();

  if (backups.length <= maxBackups) return;

  // Delete oldest backups (beyond maxBackups)
  const toDelete = backups.slice(maxBackups);
  for (const name of toDelete) {
    const backupPath = join(HOME_DIR, name);
    console.log(`  Removing old backup: ${name}`);
    rmSync(backupPath, { recursive: true, force: true });
  }
}

/**
 * Create a backup of ~/.system2 if needed.
 *
 * Skips backup if:
 * - ~/.system2 doesn't exist
 * - A backup was created within the cooldown period
 *
 * After backup, cleans up old backups beyond retention limit.
 *
 * @returns true if backup was created, false if skipped
 */
export function backupIfNeeded(): boolean {
  // Skip if no installation to back up
  if (!existsSync(SYSTEM2_DIR)) {
    return false;
  }

  // Load config for backup settings
  const config = loadConfig();
  const cooldownMs = config.backup.cooldownHours * 60 * 60 * 1000;

  // Check cooldown
  const lastBackupTime = getMostRecentBackupTime();
  if (lastBackupTime) {
    const elapsed = Date.now() - lastBackupTime.getTime();
    if (elapsed < cooldownMs) {
      const hoursAgo = Math.round(elapsed / (60 * 60 * 1000));
      console.log(`  Backup skipped (last backup ${hoursAgo}h ago)`);
      return false;
    }
  }

  // Create backup
  const backupName = generateBackupName();
  const backupPath = join(HOME_DIR, backupName);

  console.log(`  Creating backup: ~/${backupName}`);
  cpSync(SYSTEM2_DIR, backupPath, { recursive: true });

  // Cleanup old backups
  cleanupOldBackups(config.backup.maxBackups);

  return true;
}
