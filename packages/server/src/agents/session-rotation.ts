/**
 * Session Rotation
 *
 * Rotates JSONL session files when they exceed a size threshold.
 * Copies the compaction summary + kept entries to a new file.
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SESSION_FILE_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB

export interface SessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  details?: unknown;
  [key: string]: unknown;
}

/**
 * Find the most recent JSONL session file by modification time.
 * Returns null if no .jsonl files exist in the directory.
 */
export function findMostRecentSession(sessionDir: string): string | null {
  let files: string[];
  try {
    files = readdirSync(sessionDir);
  } catch {
    return null;
  }

  const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
  if (jsonlFiles.length === 0) return null;

  // Sort by mtime descending
  const sorted = jsonlFiles
    .map((f) => {
      const fullPath = join(sessionDir, f);
      const stat = statSync(fullPath);
      return { path: fullPath, mtime: stat.mtime.getTime() };
    })
    .sort((a, b) => b.mtime - a.mtime);

  return sorted[0].path;
}

/**
 * Parse JSONL file into entries.
 */
export function parseSessionEntries(filePath: string): SessionEntry[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim());
  const entries: SessionEntry[] = [];

  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines (same as SDK behavior)
    }
  }

  return entries;
}

/**
 * Find the most recent compaction entry and its index.
 */
function findLastCompaction(
  entries: SessionEntry[]
): { entry: SessionEntry; index: number } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'compaction') {
      return { entry: entries[i], index: i };
    }
  }
  return null;
}

/**
 * Generate a new session filename with current timestamp.
 */
function generateSessionFilename(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const uuid = randomUUID().slice(0, 8);
  return `${timestamp}_${uuid}.jsonl`;
}

/**
 * Create a new session header.
 */
function createSessionHeader(cwd: string): SessionEntry {
  return {
    type: 'session',
    version: 3,
    id: randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
    cwd,
  };
}

/**
 * Rotate session file if it exceeds the size threshold.
 *
 * Only call this during initialization, before a SessionManager is created.
 * Calling it while a session is running is unsafe: the SDK holds an open
 * reference to the current file and will recreate it (without a header) on
 * the next append if it disappears.
 *
 * When rotation occurs:
 * 1. Creates new JSONL file with:
 *    - New session header
 *    - Entries from firstKeptEntryId up to compaction entry
 *    - The compaction entry
 *    - All entries after the compaction entry
 * 2. Old file is renamed to <filename>.jsonl.archived
 * 3. New file is picked up by findMostRecentSession() on next initialize()
 *
 * @param sessionDir - Directory containing session JSONL files
 * @param cwd - Current working directory for session header
 * @param thresholdBytes - Size threshold (default 10MB)
 * @returns true if rotation occurred, false otherwise
 */
export function rotateSessionIfNeeded(
  sessionDir: string,
  cwd: string,
  thresholdBytes: number = SESSION_FILE_SIZE_LIMIT
): boolean {
  // Find most recent session file
  const currentFile = findMostRecentSession(sessionDir);
  if (!currentFile) {
    return false;
  }

  // Check file size
  const stat = statSync(currentFile);
  if (stat.size < thresholdBytes) {
    return false;
  }

  console.log(
    `[SessionRotation] File size ${(stat.size / 1024 / 1024).toFixed(2)}MB exceeds threshold, rotating...`
  );

  // Parse entries
  const entries = parseSessionEntries(currentFile);
  if (entries.length === 0) {
    console.log('[SessionRotation] No entries found, skipping rotation');
    return false;
  }

  // Find compaction entry
  const compaction = findLastCompaction(entries);
  if (!compaction) {
    console.log(
      '[SessionRotation] No compaction found, SDK will compact naturally. Skipping rotation.'
    );
    return false;
  }

  const { entry: compactionEntry, index: compactionIndex } = compaction;
  const firstKeptEntryId = compactionEntry.firstKeptEntryId;

  if (!firstKeptEntryId) {
    console.log('[SessionRotation] Compaction has no firstKeptEntryId, skipping rotation');
    return false;
  }

  // Find index of firstKeptEntryId
  const firstKeptIndex = entries.findIndex((e) => e.id === firstKeptEntryId);
  if (firstKeptIndex === -1) {
    console.log(
      `[SessionRotation] firstKeptEntryId ${firstKeptEntryId} not found, skipping rotation`
    );
    return false;
  }

  // Build new entries in chronological order:
  // 1. New session header
  // 2. Entries from firstKeptEntryId up to (not including) compaction entry
  // 3. The compaction entry
  // 4. All entries after the compaction entry
  const newEntries: SessionEntry[] = [];

  // Add new header
  newEntries.push(createSessionHeader(cwd));

  // Add entries from firstKeptEntryId to compaction (exclusive)
  for (let i = firstKeptIndex; i < compactionIndex; i++) {
    newEntries.push(entries[i]);
  }

  // Add compaction entry
  newEntries.push(compactionEntry);

  // Add entries after compaction
  for (let i = compactionIndex + 1; i < entries.length; i++) {
    newEntries.push(entries[i]);
  }

  // Write new file
  const newFilename = generateSessionFilename();
  const newFilePath = join(sessionDir, newFilename);
  const content = `${newEntries.map((e) => JSON.stringify(e)).join('\n')}\n`;
  writeFileSync(newFilePath, content);

  // Rename old file so it is no longer picked up as a candidate session
  const archivedPath = `${currentFile}.archived`;
  renameSync(currentFile, archivedPath);

  console.log(
    `[SessionRotation] Created new session file: ${newFilename} with ${newEntries.length} entries`
  );
  console.log(`[SessionRotation] Old file archived: ${currentFile.split('/').pop()}.archived`);

  return true;
}
