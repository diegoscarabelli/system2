/**
 * Session Rotation
 *
 * Rotates JSONL session files when they exceed a size threshold.
 * Copies the compaction summary + kept entries to a new file.
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DEFAULT_SESSION_ROTATION_SIZE_BYTES } from '../../shared/types/config.js';
import { log } from '../utils/logger.js';

/** Default rotation threshold. Imported from shared so CLI config defaults and server-side
 *  defaults cannot drift. Above this size, the JSONL is rotated. The decision between the
 *  two inner paths (anchored vs bare-bytes-tail) is made based on whether a compaction anchor
 *  exists in the file, not on size. */
const SESSION_FILE_SIZE_LIMIT = DEFAULT_SESSION_ROTATION_SIZE_BYTES;

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
export function createSessionHeader(cwd: string): SessionEntry {
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
 * Check if an entry represents the start of a user turn — a safe restart anchor
 * for a truncated session. Resuming from a user turn avoids dangling tool calls
 * or assistant continuations that would expect prior context the SDK no longer has.
 */
function isUserTurnStart(entry: SessionEntry): boolean {
  if (entry.type !== 'message') return false;
  const message = entry.message as { role?: string } | undefined;
  return message?.role === 'user';
}

/**
 * Select the suffix of `entries` that fits strictly within `tailBytes` total UTF-8
 * bytes AND starts on a safe conversation boundary (a user turn).
 *
 * Step 1: walk backward from the end summing entry sizes; stop before any entry
 * (including the newest) would push the total past `tailBytes`. If the newest
 * entry alone exceeds `tailBytes`, returns empty — the bare-bytes-tail path
 * exists to unblock cold start, and keeping a single oversized entry would
 * defeat that purpose.
 *
 * Step 2: from that byte-budget cut, walk forward (toward the newest entries) to
 * the first user-turn entry. That becomes the actual cut point. If no user turn
 * exists in the kept range, returns an empty array — better to cold-start clean
 * than to resume on a dangling tool_result or assistant continuation.
 *
 * Returned bytes are always <= `tailBytes`, and the result is always either
 * empty or starts with a user message. Entries are kept whole — never truncated
 * mid-entry.
 */
function selectTailEntries(entries: SessionEntry[], tailBytes: number): SessionEntry[] {
  if (entries.length === 0) return [];

  // Step 1: byte-budget cut. Strictly enforce tailBytes — never include an entry
  // whose addition would push the total past the cap, even on the first iteration.
  let totalBytes = 0;
  let firstIndex = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entries[i]), 'utf8');
    if (totalBytes + entryBytes > tailBytes) {
      break;
    }
    totalBytes += entryBytes;
    firstIndex = i;
  }

  // Step 2: advance forward to the first user-turn boundary in the kept range.
  // If we walk past the end, the kept range had no user turn — return empty.
  while (firstIndex < entries.length && !isUserTurnStart(entries[firstIndex])) {
    firstIndex++;
  }

  return entries.slice(firstIndex);
}

/**
 * Write rotated entries to a new JSONL and archive the old file.
 */
export function writeRotatedFile(
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
 * Bare-bytes-tail fallback: write a fresh session header + a bounded recent tail
 * (selected via selectTailEntries, anchored to a user turn) and archive the old file.
 * Used when no compaction anchor exists or the anchor is malformed.
 */
function forceBareBytesTailRotation(
  sessionDir: string,
  cwd: string,
  currentFile: string,
  entries: SessionEntry[],
  reason: string
): true {
  const tailEntries = selectTailEntries(entries, HARD_FALLBACK_TAIL_BYTES);
  const newEntries: SessionEntry[] = [createSessionHeader(cwd), ...tailEntries];
  const newFilename = writeRotatedFile(sessionDir, currentFile, newEntries);
  log.info(
    `[SessionRotation] Created new session file: ${newFilename} with ${newEntries.length} entries (bare-bytes-tail fallback: ${reason})`
  );
  log.info(`[SessionRotation] Old file archived: ${basename(currentFile)}.archived`);
  return true;
}

/**
 * Header-only fallback: write a fresh session header (no tail) and archive the old file.
 * Used when the file has no recoverable entries (e.g., 0 parsed lines).
 */
function forceHeaderOnlyRotation(
  sessionDir: string,
  cwd: string,
  currentFile: string,
  reason: string
): true {
  const newEntries: SessionEntry[] = [createSessionHeader(cwd)];
  const newFilename = writeRotatedFile(sessionDir, currentFile, newEntries);
  log.info(
    `[SessionRotation] Created new session file: ${newFilename} with ${newEntries.length} entry (header-only fallback: ${reason})`
  );
  log.info(`[SessionRotation] Old file archived: ${basename(currentFile)}.archived`);
  return true;
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
 *   stat.size < thresholdBytes              → return false (no-op)
 *   parsed 0 entries (malformed file)       → header-only rotation: write fresh header,
 *                                             archive bad file. Bounds disk; unblocks cold start.
 *   compaction anchor + valid firstKeptEntryId → anchored rotation: header + entries from
 *                                                firstKeptEntryId onward.
 *   no compaction anchor                    → bare-bytes-tail rotation: header + tail
 *                                             (selectTailEntries, ~1 MB cap, user-turn aligned).
 *   compaction missing/broken firstKeptEntryId → fall back to bare-bytes-tail rotation
 *                                                (anchor can't be trusted).
 *
 * Every path that reaches the threshold rotates the file — no path leaves an oversized JSONL on
 * disk. Fallback paths emit `warn` logs so operators see them.
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

  log.info(`[SessionRotation] File size ${formatMB(stat.size)} MB exceeds threshold, rotating...`);

  // Parse entries. If parsing yields zero usable entries (every line malformed, or whitespace-only
  // file), the file has no recoverable state — write a fresh header-only session and archive the
  // bad one. Leaving the oversized file on disk would re-trigger this branch on every cold start.
  const entries = parseSessionEntries(currentFile);
  if (entries.length === 0) {
    log.warn(
      `[SessionRotation] File exceeded threshold but parsed to 0 entries: ${currentFile} (size ${formatMB(stat.size)} MB). All lines may be malformed JSON. Forcing header-only rotation so cold start is unblocked and disk usage remains bounded.`
    );
    return forceHeaderOnlyRotation(sessionDir, cwd, currentFile, 'parsed to 0 entries');
  }

  // Find compaction entry
  const compaction = findLastCompaction(entries);
  if (!compaction) {
    // No compaction anchor: bare-bytes-tail rotation. Reaching the threshold without a
    // compaction means the agent has been failing turns long enough that the SDK never
    // wrote one — preserve only the session header + a small recent tail to unblock
    // cold start. The warn lets operators detect this failure-loop signal.
    log.warn(
      `[SessionRotation] No compaction found in ${currentFile} (size ${formatMB(stat.size)} MB). Forcing bare-bytes-tail rotation: keeping the header plus up to the last ${formatMB(HARD_FALLBACK_TAIL_BYTES)} MB of entries. If no safe user-turn anchor exists within that window, or if a single entry exceeds the cap, rotation may fall back to header-only. Older state will be archived. Repeated occurrences signal the agent has been in a failure loop.`
    );
    return forceBareBytesTailRotation(
      sessionDir,
      cwd,
      currentFile,
      entries,
      'no compaction anchor'
    );
  }

  const { entry: compactionEntry, index: compactionIndex } = compaction;
  const firstKeptEntryId = compactionEntry.firstKeptEntryId;

  if (!firstKeptEntryId) {
    // Compaction is malformed — its firstKeptEntryId is null/undefined. We can't trust the anchor
    // to define the kept range, so treat it as if no compaction existed and fall back.
    log.warn(
      `[SessionRotation] Compaction has no firstKeptEntryId in ${currentFile} (size ${formatMB(stat.size)} MB). Falling back to bare-bytes-tail rotation.`
    );
    return forceBareBytesTailRotation(
      sessionDir,
      cwd,
      currentFile,
      entries,
      'compaction missing firstKeptEntryId'
    );
  }

  // Find index of firstKeptEntryId
  const firstKeptIndex = entries.findIndex((e) => e.id === firstKeptEntryId);
  if (firstKeptIndex === -1) {
    // firstKeptEntryId doesn't match any kept entry — anchor is broken (corruption, partial
    // truncation, or rotation boundary mismatch). Same fallback as above.
    log.warn(
      `[SessionRotation] firstKeptEntryId ${firstKeptEntryId} not found in ${currentFile} (size ${formatMB(stat.size)} MB). Falling back to bare-bytes-tail rotation.`
    );
    return forceBareBytesTailRotation(
      sessionDir,
      cwd,
      currentFile,
      entries,
      `firstKeptEntryId ${firstKeptEntryId} not found`
    );
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
