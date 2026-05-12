/**
 * Session Rotation
 *
 * Rotates JSONL session files when they exceed a size threshold.
 * Copies the compaction summary + kept entries to a new file.
 */

import { randomUUID } from 'node:crypto';
import {
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  DEFAULT_SESSION_ARCHIVE_KEEP_COUNT,
  DEFAULT_SESSION_ROTATION_SIZE_BYTES,
} from '../../shared/types/config.js';
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
 * Drop orphan `toolResult` entries (and any descendants rooted on them) from a
 * rotated entry list. An orphan is a `toolResult` whose `toolCallId` is not
 * emitted by any kept assistant message's `toolCall` content block — meaning
 * the matching `tool_use` was pruned by an upstream compaction or rotation
 * step, but the `toolResult` slipped through.
 *
 * Without this filter, the SDK reconstructs an API request with a
 * `tool_result` block referencing a `tool_use_id` that has no corresponding
 * `tool_use` block, and the LLM provider rejects the request (Anthropic:
 * `unexpected tool_use_id found in tool_result blocks`; Google:
 * `function response turn must come immediately after a function call turn`).
 *
 * The root cause is upstream — pi-ai's compaction can place its cut between a
 * `tool_use` and its `tool_result`, and the compaction marker's
 * `firstKeptEntryId` records the cut without ensuring the kept range is
 * internally consistent. We can't change that from here; what we can do is
 * audit the post-rotation entry list and drop the inconsistency before the
 * file is written.
 *
 * Why we also drop descendants: an assistant message whose `parentId` chains
 * to a dropped `toolResult` was generated in response to that result. If we
 * keep it, its `parentId` becomes a dangling reference; even if the SDK
 * tolerates that, the assistant message often ends up as the first message in
 * the constructed API request, which Anthropic rejects (first message must be
 * `user`). Drop the whole stranded sub-chain so the next valid `user`-turn
 * boundary is the resume point.
 *
 * Returns `{ filtered, droppedIds }`. The helper does NOT log — callers
 * own the warn emission so they can include file-level context (session
 * basename, rotation path tag) that the helper has no access to.
 * `droppedIds` is the list of every entry id removed (orphans plus their
 * transitive descendants) so callers can include sample ids in the log
 * for operator triage.
 */
export function filterOrphanToolResults(entries: SessionEntry[]): {
  filtered: SessionEntry[];
  droppedIds: string[];
} {
  if (entries.length === 0) return { filtered: entries, droppedIds: [] };

  // Step 1: collect all `toolCall.id` values emitted by assistant messages in
  // the kept range. These are the valid targets for `toolResult.toolCallId`.
  const emittedToolCallIds = new Set<string>();
  for (const e of entries) {
    if (e.type !== 'message') continue;
    const msg = (e as SessionEntry & { message?: unknown }).message as
      | { role?: string; content?: Array<{ type?: string; id?: string }> }
      | undefined;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === 'toolCall' && typeof block.id === 'string') {
        emittedToolCallIds.add(block.id);
      }
    }
  }

  // Step 2: identify orphan `toolResult` entry ids.
  const droppedIds = new Set<string>();
  for (const e of entries) {
    if (e.type !== 'message' || !e.id) continue;
    const msg = (e as SessionEntry & { message?: unknown }).message as
      | { role?: string; toolCallId?: string }
      | undefined;
    if (msg?.role === 'toolResult' && typeof msg.toolCallId === 'string') {
      if (!emittedToolCallIds.has(msg.toolCallId)) {
        droppedIds.add(e.id);
      }
    }
  }

  if (droppedIds.size === 0) return { filtered: entries, droppedIds: [] };

  // Step 3: transitively mark every descendant of a dropped entry. Build a
  // `parentId → child ids` index and an id → entry lookup in one pass, then
  // BFS from the seed orphans. O(N) total — large rotated sessions can have
  // tens of thousands of entries, and a naive fixed-point loop would be O(N^2)
  // in the worst case (a long linear parent chain).
  //
  // Compaction markers act as structural anchors, not as continuations of the
  // pre-compaction chain: their `parentId` typically points at the last entry
  // of the kept pre-compaction tail, but the marker itself represents the
  // *boundary* between summarized history and the post-compaction
  // conversation. If we propagated the drop through the marker, every
  // post-compaction entry chained back to it would also drop — wiping the
  // resume point and effectively cold-starting the agent every time the
  // entire kept tail happens to chain to an orphan. Treat compaction entries
  // as BFS sinks: they (and everything past them) survive even when their
  // parentId resolves to a dropped entry.
  const childrenByParent = new Map<string, string[]>();
  const entryById = new Map<string, SessionEntry>();
  for (const e of entries) {
    if (!e.id) continue;
    entryById.set(e.id, e);
    if (!e.parentId) continue;
    const list = childrenByParent.get(e.parentId);
    if (list) list.push(e.id);
    else childrenByParent.set(e.parentId, [e.id]);
  }
  const queue: string[] = Array.from(droppedIds);
  while (queue.length > 0) {
    const parentId = queue.pop() as string;
    const children = childrenByParent.get(parentId);
    if (!children) continue;
    for (const childId of children) {
      if (droppedIds.has(childId)) continue;
      if (entryById.get(childId)?.type === 'compaction') continue;
      droppedIds.add(childId);
      queue.push(childId);
    }
  }

  return {
    filtered: entries.filter((e) => !e.id || !droppedIds.has(e.id)),
    droppedIds: Array.from(droppedIds),
  };
}

/**
 * Emit the orphan-filter warn log with file-level context. Centralized so the
 * two rotation paths (anchored, bare-bytes-tail) share the same format. Caller
 * supplies a short path tag identifying which rotation path triggered the
 * filter, so operators can correlate the warning with the right code path.
 */
function logOrphanFilterDrop(
  currentFile: string,
  pathTag: 'anchored-rotation' | 'bare-bytes-tail',
  droppedIds: string[]
): void {
  if (droppedIds.length === 0) return;
  const sample = droppedIds.slice(0, 5).join(', ');
  const overflow = droppedIds.length > 5 ? `, ... (${droppedIds.length - 5} more)` : '';
  log.warn(
    `[SessionRotation] Filter dropped ${droppedIds.length} orphan tool_result/dependent entries from ${basename(currentFile)} (${pathTag}; sample ids: ${sample}${overflow}). Upstream compaction or tail-selection cut between a tool_use and its tool_result; without this filter the SDK would construct an invalid API request.`
  );
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
 * Prune `.jsonl.archived` files in `sessionDir`, keeping only the `keepCount` most recent by mtime.
 *
 * No-op if `keepCount <= 0`, if the directory cannot be read, or if there are fewer archives than
 * the cap. Failures to delete individual files are logged at warn level but do not throw — pruning
 * is best-effort cleanup, not load-bearing for correctness.
 *
 * Called after every successful `writeRotatedFile` (anchored rotation, bare-bytes-tail fallback,
 * header-only fallback, and the narrator session-reset path) so archive count stays bounded for
 * high-volume agents.
 */
export function pruneArchives(sessionDir: string, keepCount: number): void {
  if (keepCount <= 0) return;
  let archived: string[];
  try {
    archived = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl.archived'));
  } catch {
    return;
  }
  if (archived.length <= keepCount) return;

  // Sort by mtime descending (newest first); delete everything past keepCount. statSync is
  // wrapped per-file: a concurrently-removed archive, broken symlink, or unreadable inode
  // should skip+log, never abort rotation.
  const sorted = archived
    .flatMap((f) => {
      const fullPath = join(sessionDir, f);
      try {
        const stat = statSync(fullPath);
        return [{ path: fullPath, mtime: stat.mtime.getTime() }];
      } catch (err) {
        log.warn(`[SessionRotation] Failed to stat archive ${fullPath}: ${err}`);
        return [];
      }
    })
    .sort((a, b) => b.mtime - a.mtime);

  const toDelete = sorted.slice(keepCount);
  const prunedNames: string[] = [];
  for (const entry of toDelete) {
    try {
      unlinkSync(entry.path);
      prunedNames.push(basename(entry.path));
    } catch (err) {
      log.warn(`[SessionRotation] Failed to prune ${entry.path}: ${err}`);
    }
  }

  // Single summary line so first-prune-after-upgrade (potentially many archives) doesn't
  // flood the log with one line per file.
  if (prunedNames.length > 0) {
    log.info(
      `[SessionRotation] Pruned ${prunedNames.length} old archive(s) in ${sessionDir}: newest=${prunedNames[0]}, oldest=${prunedNames[prunedNames.length - 1]}`
    );
  }
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
  // Defense-in-depth: selectTailEntries already cuts on a user-turn boundary
  // so the tail SHOULD be self-consistent, but the filter is cheap and the
  // alternative (an orphan-tool_result slips through and locks the conductor
  // out of every LLM provider) is unrecoverable without manual JSONL surgery.
  const { filtered: filteredTail, droppedIds: tailDroppedIds } =
    filterOrphanToolResults(tailEntries);
  logOrphanFilterDrop(currentFile, 'bare-bytes-tail', tailDroppedIds);
  const newEntries: SessionEntry[] = [createSessionHeader(cwd), ...filteredTail];
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
 * @param archiveKeepCount - Maximum `.jsonl.archived` files to retain (default 5).
 *                          Pruning runs after every successful rotation in this function.
 * @returns true if rotation occurred, false otherwise
 */
export function rotateSessionIfNeeded(
  sessionDir: string,
  cwd: string,
  thresholdBytes: number = SESSION_FILE_SIZE_LIMIT,
  archiveKeepCount: number = DEFAULT_SESSION_ARCHIVE_KEEP_COUNT
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
    const rotated = forceHeaderOnlyRotation(sessionDir, cwd, currentFile, 'parsed to 0 entries');
    pruneArchives(sessionDir, archiveKeepCount);
    return rotated;
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
    const rotated = forceBareBytesTailRotation(
      sessionDir,
      cwd,
      currentFile,
      entries,
      'no compaction anchor'
    );
    pruneArchives(sessionDir, archiveKeepCount);
    return rotated;
  }

  const { entry: compactionEntry, index: compactionIndex } = compaction;
  const firstKeptEntryId = compactionEntry.firstKeptEntryId;

  if (!firstKeptEntryId) {
    // Compaction is malformed — its firstKeptEntryId is null/undefined. We can't trust the anchor
    // to define the kept range, so treat it as if no compaction existed and fall back.
    log.warn(
      `[SessionRotation] Compaction has no firstKeptEntryId in ${currentFile} (size ${formatMB(stat.size)} MB). Falling back to bare-bytes-tail rotation.`
    );
    const rotated = forceBareBytesTailRotation(
      sessionDir,
      cwd,
      currentFile,
      entries,
      'compaction missing firstKeptEntryId'
    );
    pruneArchives(sessionDir, archiveKeepCount);
    return rotated;
  }

  // Find index of firstKeptEntryId
  const firstKeptIndex = entries.findIndex((e) => e.id === firstKeptEntryId);
  if (firstKeptIndex === -1) {
    // firstKeptEntryId doesn't match any kept entry — anchor is broken (corruption, partial
    // truncation, or rotation boundary mismatch). Same fallback as above.
    log.warn(
      `[SessionRotation] firstKeptEntryId ${firstKeptEntryId} not found in ${currentFile} (size ${formatMB(stat.size)} MB). Falling back to bare-bytes-tail rotation.`
    );
    const rotated = forceBareBytesTailRotation(
      sessionDir,
      cwd,
      currentFile,
      entries,
      `firstKeptEntryId ${firstKeptEntryId} not found`
    );
    pruneArchives(sessionDir, archiveKeepCount);
    return rotated;
  }

  // Build new entries in chronological order:
  // 1. New session header
  // 2. Entries from firstKeptEntryId up to (not including) compaction entry
  // 3. The compaction entry
  // 4. All entries after the compaction entry
  //
  // Pi-ai's compaction selects a `firstKeptEntryId` that defines the cut
  // between the summary and the kept tail, but the implementation can place
  // that cut between a `tool_use` and its corresponding `tool_result` —
  // leaving the result orphaned in the kept range. The filter below scans
  // the assembled list for orphan `toolResult` entries and drops them (plus
  // any descendants chaining back to them) before the file is written.
  // Without this, the SDK reconstructs an API request the LLM provider
  // rejects on the very first turn after rotation, locking the agent out
  // until manual JSONL surgery.
  let newEntries: SessionEntry[] = [];

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

  // Drop orphan tool_result/dependents (see comment above the assignment).
  const { filtered: filteredEntries, droppedIds: anchoredDroppedIds } =
    filterOrphanToolResults(newEntries);
  logOrphanFilterDrop(currentFile, 'anchored-rotation', anchoredDroppedIds);
  newEntries = filteredEntries;

  // Write new file (and archive old)
  const newFilename = writeRotatedFile(sessionDir, currentFile, newEntries);

  log.info(
    `[SessionRotation] Created new session file: ${newFilename} with ${newEntries.length} entries`
  );
  log.info(`[SessionRotation] Old file archived: ${basename(currentFile)}.archived`);

  pruneArchives(sessionDir, archiveKeepCount);
  return true;
}
