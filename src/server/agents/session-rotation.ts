/**
 * Session Rotation
 *
 * Rotates JSONL session files when they exceed a size threshold.
 * Copies the compaction summary + kept entries to a new file.
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { log } from '../utils/logger.js';

/** Default rotation threshold. Above this size, the JSONL is rotated. The decision between the
 *  two inner paths (anchored vs bare-bytes-tail) is made based on whether a compaction anchor
 *  exists in the file, not on size. */
const SESSION_FILE_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB

/** Tail-keep cap for the bare-bytes-tail path (no compaction anchor present). Intentionally small:
 *  if the agent has grown the JSONL past `rotation_size_bytes` with no compactions, recent context
 *  is almost certainly polluted by error retries. Keeping more than ~1 MB defeats the purpose; the
 *  goal is to unblock cold start, not preserve the failure trail. */
const HARD_FALLBACK_TAIL_BYTES = 1 * 1024 * 1024; // 1MB

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
 * Format a byte count as megabytes with 2 decimal places.
 */
function formatMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2);
}

/**
 * Select the suffix of `entries` that fits within `tailBytes` total UTF-8 bytes
 * (sum of `JSON.stringify(entry)` lengths). Walks from the end backward; stops
 * once adding the next-newer entry would exceed the cap. Always returns at least
 * the single newest entry, even if that one entry exceeds the cap.
 */
function selectTailEntries(entries: SessionEntry[], tailBytes: number): SessionEntry[] {
  if (entries.length === 0) return [];

  let totalBytes = 0;
  let firstIndex = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entries[i]), 'utf8');
    if (totalBytes + entryBytes > tailBytes && firstIndex < entries.length) {
      break;
    }
    totalBytes += entryBytes;
    firstIndex = i;
  }
  return entries.slice(firstIndex);
}

/**
 * Write rotated entries to a new JSONL and archive the old file.
 */
function writeRotatedFile(
  sessionDir: string,
  oldFilePath: string,
  newEntries: SessionEntry[]
): string {
  const newFilename = generateSessionFilename();
  const newFilePath = join(sessionDir, newFilename);
  const content = `${newEntries.map((e) => JSON.stringify(e)).join('\n')}\n`;
  writeFileSync(newFilePath, content);

  const archivedPath = `${oldFilePath}.archived`;
  renameSync(oldFilePath, archivedPath);

  return newFilename;
}

/**
 * Rotate session file if it exceeds the size threshold.
 *
 * Only call this during initialization, before a SessionManager is created.
 * Calling it while a session is running is unsafe: the SDK holds an open
 * reference to the current file and will recreate it (without a header) on
 * the next append if it disappears.
 *
 * Decision tree (file size = `stat.size`):
 *
 *   stat.size < thresholdBytes        → return false (no-op)
 *   compaction anchor present         → anchored rotation: header + entries from
 *                                       firstKeptEntryId onward
 *   no compaction anchor              → bare-bytes-tail rotation: header + last
 *                                       HARD_FALLBACK_TAIL_BYTES (~1 MB) of entries.
 *                                       Emits a warn — the absence of a compaction at
 *                                       this size signals the agent has been in a
 *                                       failure loop.
 *
 * @param sessionDir - Directory containing session JSONL files
 * @param cwd - Current working directory for session header
 * @param thresholdBytes - Rotation threshold (default 10 MB)
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

  log.info(`[SessionRotation] File size ${formatMB(stat.size)}MB exceeds threshold, rotating...`);

  // Parse entries
  const entries = parseSessionEntries(currentFile);
  if (entries.length === 0) {
    log.info('[SessionRotation] No entries found, skipping rotation');
    return false;
  }

  // Find compaction entry
  const compaction = findLastCompaction(entries);
  if (!compaction) {
    // No compaction anchor: bare-bytes-tail rotation. Reaching the threshold without a
    // compaction means the agent has been failing turns long enough that the SDK never
    // wrote one — preserve only the session header + a small recent tail to unblock
    // cold start. The warn lets operators detect this failure-loop signal.
    log.warn(
      `[SessionRotation] No compaction found in ${currentFile} (size ${formatMB(stat.size)} MB). Forcing bare-bytes-tail rotation: keeping header + last ${formatMB(HARD_FALLBACK_TAIL_BYTES)} MB of entries. Older state will be archived. Repeated occurrences signal the agent has been in a failure loop.`
    );

    const tailEntries = selectTailEntries(entries, HARD_FALLBACK_TAIL_BYTES);
    const newEntries: SessionEntry[] = [createSessionHeader(cwd), ...tailEntries];
    const newFilename = writeRotatedFile(sessionDir, currentFile, newEntries);

    log.info(
      `[SessionRotation] Created new session file: ${newFilename} with ${newEntries.length} entries (bare-bytes-tail fallback)`
    );
    log.info(`[SessionRotation] Old file archived: ${basename(currentFile)}.archived`);
    return true;
  }

  const { entry: compactionEntry, index: compactionIndex } = compaction;
  const firstKeptEntryId = compactionEntry.firstKeptEntryId;

  if (!firstKeptEntryId) {
    log.warn(
      `[SessionRotation] Compaction has no firstKeptEntryId in ${currentFile} (size ${formatMB(stat.size)} MB), skipping rotation`
    );
    return false;
  }

  // Find index of firstKeptEntryId
  const firstKeptIndex = entries.findIndex((e) => e.id === firstKeptEntryId);
  if (firstKeptIndex === -1) {
    log.warn(
      `[SessionRotation] firstKeptEntryId ${firstKeptEntryId} not found in ${currentFile} (size ${formatMB(stat.size)} MB), skipping rotation`
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

  // Write new file (and archive old)
  const newFilename = writeRotatedFile(sessionDir, currentFile, newEntries);

  log.info(
    `[SessionRotation] Created new session file: ${newFilename} with ${newEntries.length} entries`
  );
  log.info(`[SessionRotation] Old file archived: ${basename(currentFile)}.archived`);

  return true;
}
