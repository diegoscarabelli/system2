/**
 * Scheduled Job Definitions
 *
 * Registers cron jobs for the Narrator agent. Jobs pre-compute all deterministic
 * data (timestamps, file paths, JSONL records, DB changes) so the Narrator
 * receives a ready-to-use message and can focus on narrative synthesis.
 *
 * sender: 0 is a sentinel for system-generated messages (no agent sender).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { JobExecution } from '../../shared/index.js';
import type { AgentHost } from '../agents/host.js';
import { commitIfStateDir } from '../agents/tools/git-commit.js';
import type { DatabaseClient } from '../db/client.js';
import { resolveProjectDir } from '../projects/dir.js'; // used for backfilling dir_name on legacy projects
import { log } from '../utils/logger.js';
import { isNetworkAvailable } from './network.js';
import type { Scheduler } from './scheduler.js';

/** Entry types to include from JSONL session files */
const INCLUDED_ENTRY_TYPES = new Set(['message', 'custom_message']);

/** Per-message excerpt cap when feeding session JSONL into Narrator-bound deliveries
 *  (daily-summary cron and trigger_project_story tool). 16 KB captures most legitimate
 *  inter-agent payloads while aggressively truncating 1+ MB pathological cases. */
export const NARRATOR_MESSAGE_EXCERPT_BYTES = 16 * 1024;

/** Producer-side budget for a single inter-agent delivery (half of MAX_DELIVERY_BYTES by default,
 *  leaving room for headers, DB-changes section, and SDK request overhead).
 *  Configurable via [delivery] catch_up_budget_bytes in config.toml. */
export const CATCH_UP_BUDGET_BYTES = 512 * 1024;

/**
 * A session entry with its timestamp exposed alongside the pre-stripped JSON rendering.
 */
export interface TimestampedEntry {
  /** Stable per-entry identifier: `${agentRole}_${agentId}:${fileBasename}:${lineIndex}` */
  id: string;
  timestamp: string;
  rendered: string; // pre-stripped, JSON-encoded line
  /** Agent section label for grouping in renderAgentActivitySections */
  agentLabel: string;
}

/**
 * Result of truncateOldestToFit.
 */
export interface TruncateResult {
  kept: TimestampedEntry[];
  droppedCount: number;
  droppedRange: { from: string; to: string } | null;
}

/**
 * Truncate the oldest entries from `entries` until the total rendered size fits within
 * `budget` bytes. Entries are sorted by timestamp ascending before truncation so the
 * oldest are always dropped first. Dropped entries are gone permanently — they are not
 * deferred.
 */
export function truncateOldestToFit(entries: TimestampedEntry[], budget: number): TruncateResult {
  if (entries.length === 0) return { kept: [], droppedCount: 0, droppedRange: null };
  const sorted = [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const sizes = sorted.map((e) => Buffer.byteLength(e.rendered, 'utf8'));
  let total = sizes.reduce((s, size) => s + size, 0);
  if (total <= budget) return { kept: sorted, droppedCount: 0, droppedRange: null };

  let droppedCount = 0;
  while (total > budget && droppedCount < sorted.length) {
    total -= sizes[droppedCount];
    droppedCount += 1;
  }

  return {
    kept: sorted.slice(droppedCount),
    droppedCount,
    droppedRange:
      droppedCount > 0
        ? { from: sorted[0].timestamp, to: sorted[droppedCount - 1].timestamp }
        : null,
  };
}

/**
 * Format a truncation annotation line to prepend to a delivery body when entries were
 * dropped. Returns an empty string if nothing was dropped.
 *
 * @param budget The ACTUAL activity budget used by the truncation (not the global
 *   CATCH_UP_BUDGET_BYTES constant). After subtracting header + DB-changes overhead the
 *   effective budget is smaller, and the annotation should report the number callers see.
 */
function annotateTruncation(result: TruncateResult, budget: number): string {
  if (result.droppedCount === 0 || !result.droppedRange) return '';
  return (
    `\n\n[NOTE: dropped ${result.droppedCount} oldest entries spanning ` +
    `${result.droppedRange.from} → ${result.droppedRange.to} ` +
    `to fit ${budget.toLocaleString()}-byte delivery budget]\n\n`
  );
}

/**
 * Read a YAML frontmatter field from the first few lines of a file.
 */
export function readFrontmatterField(filePath: string, field: string): string | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').slice(0, 10);
  for (const line of lines) {
    const match = line.match(new RegExp(`^${field}:\\s*(.+)\\s*$`));
    if (match?.[1].trim()) {
      return match[1].trim();
    }
  }
  return null;
}

/**
 * Write a YAML frontmatter field in a file.
 * If the field exists, its value is replaced. If the frontmatter block exists
 * but the field is missing, the field is inserted after the opening `---`.
 */
export function writeFrontmatterField(filePath: string, field: string, value: string): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // Find frontmatter boundaries
  if (lines[0]?.trim() !== '---') return;
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return;

  // Try to replace existing field
  let replaced = false;
  for (let i = 1; i < endIdx; i++) {
    if (lines[i].match(new RegExp(`^${field}:`))) {
      lines[i] = `${field}: ${value}`;
      replaced = true;
      break;
    }
  }

  // Insert if not found
  if (!replaced) {
    lines.splice(1, 0, `${field}: ${value}`);
  }

  writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

/**
 * Read the last N characters of a file.
 */
export function readTailChars(filePath: string, n: number): string {
  if (!existsSync(filePath)) return '';
  const content = readFileSync(filePath, 'utf-8');
  if (content.length <= n) return content;
  return content.slice(-n);
}

/**
 * Get the last_narrator_update_ts from the most recent daily summary file.
 */
function getMostRecentSummaryTimestamp(summariesDir: string): string | null {
  if (!existsSync(summariesDir)) return null;
  const files = readdirSync(summariesDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse();

  for (const file of files) {
    const ts = readFrontmatterField(join(summariesDir, file), 'last_narrator_update_ts');
    if (ts) return ts;
  }
  return null;
}

/**
 * Resolve the daily summary timestamp using the fallback chain:
 * 1. Today's daily summary frontmatter
 * 2. Most recent daily summary frontmatter (by filename sort)
 * 3. memory.md frontmatter
 * 4. null (first run)
 */
export function resolveDailySummaryTimestamp(
  system2Dir: string,
  _intervalMinutes: number
): { filePath: string; lastRunTs: string | null; newRunTs: string } {
  const newRunTs = new Date().toISOString();
  const today = newRunTs.slice(0, 10);
  const summariesDir = join(system2Dir, 'knowledge', 'daily_summaries');
  const filePath = join(summariesDir, `${today}.md`);

  // Try today's file frontmatter
  let lastRunTs = readFrontmatterField(filePath, 'last_narrator_update_ts');
  if (lastRunTs) return { filePath, lastRunTs, newRunTs };

  // Try most recent daily summary by filename
  lastRunTs = getMostRecentSummaryTimestamp(summariesDir);
  if (lastRunTs) return { filePath, lastRunTs, newRunTs };

  // Try memory.md
  const memoryPath = join(system2Dir, 'knowledge', 'memory.md');
  lastRunTs = readFrontmatterField(memoryPath, 'last_narrator_update_ts');
  if (lastRunTs) return { filePath, lastRunTs, newRunTs };

  // First run — no timestamps found anywhere
  return { filePath, lastRunTs: null, newRunTs };
}

/**
 * Collect JSONL session entries for all non-archived agents in the time window.
 * Returns the activity as a formatted string for direct embedding in delivery bodies.
 */
export function collectAgentActivity(
  system2Dir: string,
  agents: Array<{ id: number; role: string; project_name: string | null }>,
  lastRunTs: string,
  newRunTs: string,
  narratorMessageExcerptBytes: number = NARRATOR_MESSAGE_EXCERPT_BYTES
): string {
  const timestamped = collectAgentActivityWithTimestamps(
    system2Dir,
    agents,
    lastRunTs,
    newRunTs,
    narratorMessageExcerptBytes
  );
  return renderAgentActivitySections(
    system2Dir,
    agents,
    lastRunTs,
    newRunTs,
    timestamped,
    narratorMessageExcerptBytes
  );
}

/**
 * Collect JSONL session entries for all non-archived agents in the time window.
 * Returns a flat array of TimestampedEntry values (one per session line), preserving
 * timestamps for oldest-first truncation. Call renderAgentActivitySections to turn
 * the result back into a formatted string.
 */
export function collectAgentActivityWithTimestamps(
  system2Dir: string,
  agents: Array<{ id: number; role: string; project_name: string | null }>,
  lastRunTs: string,
  newRunTs: string,
  narratorMessageExcerptBytes: number = NARRATOR_MESSAGE_EXCERPT_BYTES,
  cache?: Map<string, TimestampedEntry[]>
): TimestampedEntry[] {
  const all: TimestampedEntry[] = [];
  for (const agent of agents) {
    const agentIdStr = `${agent.role}_${agent.id}`;
    const cached = cache?.get(agentIdStr);
    if (cached !== undefined) {
      all.push(...cached);
      continue;
    }
    const sessionDir = join(system2Dir, 'sessions', agentIdStr);
    if (!existsSync(sessionDir)) continue;
    const agentLabel = agent.project_name
      ? `${agentIdStr} (project: ${agent.project_name})`
      : `${agentIdStr} (system-wide)`;
    const entries = readSessionEntries(
      sessionDir,
      lastRunTs,
      newRunTs,
      narratorMessageExcerptBytes,
      agentIdStr,
      agentLabel
    );
    cache?.set(agentIdStr, entries);
    all.push(...entries);
  }
  return all;
}

/**
 * Render a formatted activity string from a pre-collected set of TimestampedEntry values,
 * grouped by agent label. Agents with no entries get an "(no activity)" placeholder.
 * Accepts an optional pre-filtered `entries` array to support truncation: pass the result
 * of `truncateOldestToFit(...).kept` to render only retained entries.
 *
 * When `entries` is provided, grouping is done via the stable `agentLabel` field on each
 * entry — no re-reads, no Set-based dedup (which was buggy when two distinct entries
 * rendered to identical strings). Each entry appears at most once because it carries a
 * stable `id` assigned at read time.
 */
export function renderAgentActivitySections(
  system2Dir: string,
  agents: Array<{ id: number; role: string; project_name: string | null }>,
  lastRunTs: string,
  newRunTs: string,
  entries?: TimestampedEntry[],
  narratorMessageExcerptBytes: number = NARRATOR_MESSAGE_EXCERPT_BYTES
): string {
  const sections: string[] = [];

  if (entries !== undefined) {
    // Fast path: group the pre-filtered entries by agentLabel, then render in agent order.
    // No filesystem re-reads, no Set-based rendered-string dedup.
    const byLabel = new Map<string, TimestampedEntry[]>();
    for (const e of entries) {
      let bucket = byLabel.get(e.agentLabel);
      if (!bucket) {
        bucket = [];
        byLabel.set(e.agentLabel, bucket);
      }
      bucket.push(e);
    }

    for (const agent of agents) {
      const agentIdStr = `${agent.role}_${agent.id}`;
      const label = agent.project_name
        ? `${agentIdStr} (project: ${agent.project_name})`
        : `${agentIdStr} (system-wide)`;
      const agentEntries = byLabel.get(label) ?? [];
      if (agentEntries.length === 0) {
        sections.push(`### ${label}\n\n(no activity)\n`);
      } else {
        sections.push(`### ${label}\n\n${agentEntries.map((e) => e.rendered).join('\n')}\n`);
      }
    }
  } else {
    // Slow path (no pre-filtering): read each agent's session entries from disk.
    for (const agent of agents) {
      const agentIdStr = `${agent.role}_${agent.id}`;
      const sessionDir = join(system2Dir, 'sessions', agentIdStr);
      const label = agent.project_name
        ? `${agentIdStr} (project: ${agent.project_name})`
        : `${agentIdStr} (system-wide)`;

      if (!existsSync(sessionDir)) {
        sections.push(`### ${label}\n\n(no activity)\n`);
        continue;
      }

      const agentEntries = readSessionEntries(
        sessionDir,
        lastRunTs,
        newRunTs,
        narratorMessageExcerptBytes,
        agentIdStr,
        label
      );

      if (agentEntries.length === 0) {
        sections.push(`### ${label}\n\n(no activity)\n`);
      } else {
        sections.push(`### ${label}\n\n${agentEntries.map((e) => e.rendered).join('\n')}\n`);
      }
    }
  }

  return sections.join('\n');
}

/**
 * Strip verbose fields from a parsed JSONL session entry before injecting into
 * the Narrator's context. Removes fields that are useless for narrative synthesis
 * (textSignature/thoughtSignature crypto signatures, token usage, provider metadata,
 * raw tool outputs) and truncates large argument/result values to 100 chars.
 *
 * Operates on plain objects — never mutates the input.
 *
 * @param entry The parsed JSONL entry to strip.
 * @param narratorMessageExcerptBytes Narrator message excerpt cap in bytes. Defaults to NARRATOR_MESSAGE_EXCERPT_BYTES.
 */
export function stripSessionEntry(
  entry: Record<string, unknown>,
  narratorMessageExcerptBytes: number = NARRATOR_MESSAGE_EXCERPT_BYTES
): Record<string, unknown> {
  const type = entry.type;

  if (type === 'custom_message') {
    const { details: _d, ...rest } = entry;
    if (typeof rest.content === 'string') {
      if (Buffer.byteLength(rest.content, 'utf8') > narratorMessageExcerptBytes) {
        let truncated = rest.content.slice(0, narratorMessageExcerptBytes);
        // Trim further if multi-byte chars pushed bytes over budget
        while (Buffer.byteLength(truncated, 'utf8') > narratorMessageExcerptBytes) {
          truncated = truncated.slice(0, -1);
        }
        rest.content =
          truncated +
          `\n\n[...truncated: narrator message excerpt exceeded ${narratorMessageExcerptBytes}-byte budget]`;
      }
    }
    return rest;
  }

  if (type !== 'message') return entry;

  const msg = entry.message;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return entry;
  const message = msg as Record<string, unknown>;
  const role = message.role;

  if (role === 'assistant') {
    const { usage: _u, api: _a, provider: _p, model: _m, ...strippedMsg } = message;
    const content = message.content;
    if (Array.isArray(content)) {
      strippedMsg.content = content
        .filter((block) => {
          if (!block || typeof block !== 'object' || Array.isArray(block)) return true;
          // Drop thinking blocks entirely (internal LLM reasoning, no narrative value)
          return (block as Record<string, unknown>).type !== 'thinking';
        })
        .map((block) => {
          if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
          const b = block as Record<string, unknown>;
          if (b.type === 'text') {
            const { textSignature: _ts, ...rest } = b;
            return rest;
          }
          if (b.type !== 'toolCall') return b;
          const { thoughtSignature: _ts, arguments: args, ...rest } = b;
          if (args !== undefined) {
            let processedArgs: unknown;
            if (args && typeof args === 'object' && !Array.isArray(args)) {
              const truncatedArgs: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
                truncatedArgs[k] = typeof v === 'string' && v.length > 100 ? v.slice(0, 100) : v;
              }
              processedArgs = truncatedArgs;
            } else if (typeof args === 'string' && args.length > 100) {
              processedArgs = args.slice(0, 100);
            } else {
              processedArgs = args;
            }
            return { ...rest, arguments: processedArgs };
          }
          return rest;
        });
    }
    return { ...entry, message: strippedMsg };
  }

  if (role === 'toolResult') {
    const { details: _d, ...strippedMsg } = message;
    const content = message.content;
    if (Array.isArray(content)) {
      strippedMsg.content = content.map((block) => {
        if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
        const b = block as Record<string, unknown>;
        if (b.type !== 'text' || typeof b.text !== 'string') return b;
        return b.text.length > 100 ? { ...b, text: b.text.slice(0, 100) } : b;
      });
    } else if (typeof content === 'string' && content.length > 100) {
      strippedMsg.content = content.slice(0, 100);
    }
    return { ...entry, message: strippedMsg };
  }

  return entry;
}

/**
 * Read JSONL entries from all session files in a directory, filtered by time window.
 * Returns TimestampedEntry values so callers can apply oldest-first truncation before
 * rendering. The `rendered` field is the pre-stripped, JSON-encoded string.
 *
 * @param agentIdStr Stable agent identifier string (e.g. "guide_1") used to build entry IDs.
 * @param agentLabel Human-readable section label for this agent (used for grouping in render).
 */
function readSessionEntries(
  sessionDir: string,
  lastRunTs: string,
  newRunTs: string,
  narratorMessageExcerptBytes: number = NARRATOR_MESSAGE_EXCERPT_BYTES,
  agentIdStr = 'unknown',
  agentLabel = 'unknown'
): TimestampedEntry[] {
  const files = readdirSync(sessionDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();

  const entries: TimestampedEntry[] = [];

  for (const file of files) {
    const filePath = join(sessionDir, file);
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Increment lineIndex once per non-empty line regardless of filtering or parse outcome,
    // so entry IDs stay stable as INCLUDED_ENTRY_TYPES or other filters change.
    let lineIndex = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!INCLUDED_ENTRY_TYPES.has(entry.type)) continue;
        if (!entry.timestamp) continue;

        const ts = entry.timestamp as string;
        if (ts >= lastRunTs && ts < newRunTs) {
          entries.push({
            id: `${agentIdStr}:${file}:${lineIndex}`,
            timestamp: ts,
            rendered: JSON.stringify(stripSessionEntry(entry, narratorMessageExcerptBytes)),
            agentLabel,
          });
        }
      } catch {
        // Skip malformed lines
      } finally {
        lineIndex++;
      }
    }
  }

  return entries;
}

/**
 * A structured DB table result, ready for budget-aware rendering.
 */
export interface DbChangeTable {
  name: string;
  sql: string;
  rows: Record<string, unknown>[];
  timeColumn: string;
}

/**
 * Result of truncateDbChangesToFit.
 */
export interface DbTruncateResult {
  rendered: string;
  droppedTotal: number;
  droppedRanges: Array<{ table: string; from: string; to: string; count: number }>;
}

/** Fraction of catchUpBudgetBytes reserved for the DB-changes section.
 *  Leaves 75% for agent activity (richer narrative material). The 25% cap
 *  is a conservative starting point: most DB-change windows are small, so
 *  the budget is rarely hit. It can be tuned upward if structured data proves
 *  routinely large relative to agent activity. */
const DB_CHANGES_BUDGET_FRACTION = 0.25;

/**
 * Truncate DB-change tables toward a byte budget, keeping the newest rows.
 * The budget is split evenly across non-empty tables only and is used for
 * retained row content. Unused budget from empty tables is reclaimed and
 * distributed to tables with data. Empty tables still render their
 * "(no changes)" placeholders for visibility, and fixed rendering overhead
 * such as table headers, SQL text, blank lines, and dropped-row annotations
 * is added separately. As a result, the final rendered output is best-effort
 * and may exceed `budget`.
 */
export function truncateDbChangesToFit(tables: DbChangeTable[], budget: number): DbTruncateResult {
  if (tables.length === 0) return { rendered: '', droppedTotal: 0, droppedRanges: [] };

  // Pass 1: identify non-empty tables
  const nonEmptyTables = tables.filter((t) => t.rows.length > 0);

  // If all tables are empty, render them as-is with no truncation
  if (nonEmptyTables.length === 0) {
    return { rendered: renderDbChangeTables(tables), droppedTotal: 0, droppedRanges: [] };
  }

  // Pass 2: divide budget across non-empty tables only
  const perTableBudget = Math.floor(budget / nonEmptyTables.length);
  const droppedRanges: Array<{ table: string; from: string; to: string; count: number }> = [];
  let droppedTotal = 0;
  const sections: string[] = [];

  for (const table of tables) {
    sections.push(`### ${table.name}`);
    sections.push(table.sql);
    sections.push('');

    if (table.rows.length === 0) {
      sections.push('(no changes)\n');
      continue;
    }

    // Sort newest-first so we keep the most recent rows when truncating.
    const sorted = [...table.rows].sort((a, b) => {
      const av = String(a[table.timeColumn] ?? '');
      const bv = String(b[table.timeColumn] ?? '');
      return bv.localeCompare(av); // descending
    });

    // Walk newest-first, accumulate until budget exhausted.
    // Special case: if the very first (newest) row alone exceeds the per-table budget,
    // drop ALL rows for this table — keeping it would blow the budget guarantee.
    const firstRowSize = Buffer.byteLength(
      `| ${Object.values(sorted[0])
        .map((v) => String(v ?? ''))
        .join(' | ')} |\n`,
      'utf8'
    );
    if (firstRowSize > perTableBudget) {
      const timestamps = sorted
        .map((r) => String(r[table.timeColumn] ?? ''))
        .sort((a, b) => a.localeCompare(b));
      const from = timestamps[0];
      const to = timestamps[timestamps.length - 1];
      droppedRanges.push({ table: table.name, from, to, count: sorted.length });
      droppedTotal += sorted.length;
      sections.push(
        `[NOTE: dropped all ${sorted.length} rows from ${table.name} — first row alone exceeds per-table budget of ${perTableBudget.toLocaleString()} bytes]\n`
      );
      continue;
    }

    const kept: Record<string, unknown>[] = [];
    let accumulated = 0;
    for (const row of sorted) {
      const rowSize = Buffer.byteLength(
        `| ${Object.values(row)
          .map((v) => String(v ?? ''))
          .join(' | ')} |\n`,
        'utf8'
      );
      if (accumulated + rowSize > perTableBudget && kept.length > 0) break;
      kept.push(row);
      accumulated += rowSize;
    }

    const dropped = sorted.length - kept.length;
    if (dropped > 0) {
      // Oldest dropped rows are at the tail of sorted (ascending order for range).
      const droppedRows = sorted.slice(kept.length);
      const timestamps = droppedRows
        .map((r) => String(r[table.timeColumn] ?? ''))
        .sort((a, b) => a.localeCompare(b));
      const from = timestamps[0];
      const to = timestamps[timestamps.length - 1];
      droppedRanges.push({ table: table.name, from, to, count: dropped });
      droppedTotal += dropped;
    }

    // Render in ascending time order (newest-first array reversed).
    const ascRows = [...kept].reverse();
    sections.push(formatMarkdownTable(ascRows));
    sections.push('');

    if (dropped > 0) {
      const range = droppedRanges[droppedRanges.length - 1];
      sections.push(
        `[NOTE: dropped ${range.count} oldest DB-change rows from ${range.table} spanning ${range.from} → ${range.to}]\n`
      );
    }
  }

  return { rendered: sections.join('\n'), droppedTotal, droppedRanges };
}

/**
 * Collect database changes in the time window, formatted as markdown.
 */
export function collectDbChanges(db: DatabaseClient, lastRunTs: string, newRunTs: string): string {
  const tables = [
    { name: 'task', timeColumn: 'updated_at' },
    { name: 'project', timeColumn: 'updated_at' },
    { name: 'task_comment', timeColumn: 'created_at' },
    { name: 'task_link', timeColumn: 'created_at' },
  ];

  const sections: string[] = [];

  for (const { name, timeColumn } of tables) {
    const sql = `SELECT * FROM ${name} WHERE ${timeColumn} >= '${lastRunTs}' AND ${timeColumn} < '${newRunTs}' ORDER BY ${timeColumn} ASC`;
    const rows = db.query(sql) as Record<string, unknown>[];

    sections.push(`### ${name}`);
    sections.push(sql);
    sections.push('');

    if (rows.length === 0) {
      sections.push('(no changes)\n');
    } else {
      sections.push(formatMarkdownTable(rows));
      sections.push('');
    }
  }

  return sections.join('\n');
}

/**
 * Format an array of objects as a markdown table.
 */
export function formatMarkdownTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '(no data)';

  const columns = Object.keys(rows[0]);
  const header = `| ${columns.join(' | ')} |`;
  const separator = `|${columns.map(() => '---').join('|')}|`;
  const body = rows
    .map((row) => `| ${columns.map((col) => String(row[col] ?? '')).join(' | ')} |`)
    .join('\n');

  return `${header}\n${separator}\n${body}`;
}

/** Data collected for a single active project, reused across project log and daily summary */
interface ProjectActivityData {
  projectId: number;
  projectName: string;
  logFile: string;
  dbTables: DbChangeTable[];
  hasChanges: boolean;
}

type AgentRow = { id: number; role: string; project_name: string | null };

/**
 * Collect database changes scoped to a specific project.
 * Returns structured DbChangeTable objects for budget-aware rendering.
 */
export function collectProjectDbChanges(
  db: DatabaseClient,
  projectId: number,
  lastRunTs: string,
  newRunTs: string
): DbChangeTable[] {
  const queries: Array<{ name: string; sql: string; timeColumn: string }> = [
    {
      name: 'project',
      timeColumn: 'updated_at',
      sql: `SELECT * FROM project WHERE id = ${projectId} AND updated_at >= '${lastRunTs}' AND updated_at < '${newRunTs}'`,
    },
    {
      name: 'task',
      timeColumn: 'updated_at',
      sql: `SELECT * FROM task WHERE project = ${projectId} AND updated_at >= '${lastRunTs}' AND updated_at < '${newRunTs}' ORDER BY updated_at ASC`,
    },
    {
      name: 'task_comment',
      timeColumn: 'created_at',
      sql: `SELECT tc.* FROM task_comment tc JOIN task t ON tc.task = t.id WHERE t.project = ${projectId} AND tc.created_at >= '${lastRunTs}' AND tc.created_at < '${newRunTs}' ORDER BY tc.created_at ASC`,
    },
    {
      name: 'task_link',
      timeColumn: 'created_at',
      sql: `SELECT tl.* FROM task_link tl JOIN task t ON tl.source = t.id WHERE t.project = ${projectId} AND tl.created_at >= '${lastRunTs}' AND tl.created_at < '${newRunTs}' ORDER BY tl.created_at ASC`,
    },
  ];

  return queries.map(({ name, sql, timeColumn }) => ({
    name,
    sql,
    timeColumn,
    rows: db.query(sql) as Record<string, unknown>[],
  }));
}

/**
 * Collect database changes NOT belonging to any of the given project IDs.
 * Captures standalone tasks and changes to inactive/completed projects.
 * Returns structured DbChangeTable objects for budget-aware rendering.
 */
export function collectNonProjectDbChanges(
  db: DatabaseClient,
  activeProjectIds: number[],
  lastRunTs: string,
  newRunTs: string
): DbChangeTable[] {
  const projectExcl =
    activeProjectIds.length > 0 ? `AND id NOT IN (${activeProjectIds.join(',')})` : '';
  const taskExcl =
    activeProjectIds.length > 0
      ? `AND (project IS NULL OR project NOT IN (${activeProjectIds.join(',')}))`
      : '';
  const joinTaskExcl =
    activeProjectIds.length > 0
      ? `AND (t.project IS NULL OR t.project NOT IN (${activeProjectIds.join(',')}))`
      : '';

  const queries: Array<{ name: string; sql: string; timeColumn: string }> = [
    {
      name: 'project',
      timeColumn: 'updated_at',
      sql: `SELECT * FROM project WHERE updated_at >= '${lastRunTs}' AND updated_at < '${newRunTs}' ${projectExcl} ORDER BY updated_at ASC`,
    },
    {
      name: 'task',
      timeColumn: 'updated_at',
      sql: `SELECT * FROM task WHERE updated_at >= '${lastRunTs}' AND updated_at < '${newRunTs}' ${taskExcl} ORDER BY updated_at ASC`,
    },
    {
      name: 'task_comment',
      timeColumn: 'created_at',
      sql: `SELECT tc.* FROM task_comment tc JOIN task t ON tc.task = t.id WHERE tc.created_at >= '${lastRunTs}' AND tc.created_at < '${newRunTs}' ${joinTaskExcl} ORDER BY tc.created_at ASC`,
    },
    {
      name: 'task_link',
      timeColumn: 'created_at',
      sql: `SELECT tl.* FROM task_link tl JOIN task t ON tl.source = t.id WHERE tl.created_at >= '${lastRunTs}' AND tl.created_at < '${newRunTs}' ${joinTaskExcl} ORDER BY tl.created_at ASC`,
    },
  ];

  return queries.map(({ name, sql, timeColumn }) => ({
    name,
    sql,
    timeColumn,
    rows: db.query(sql) as Record<string, unknown>[],
  }));
}

/**
 * Render a list of DbChangeTable objects to a markdown string with no truncation.
 * Used for tables that are already within budget or when budget is not a concern.
 */
function renderDbChangeTables(tables: DbChangeTable[]): string {
  const sections: string[] = [];
  for (const table of tables) {
    sections.push(`### ${table.name}`);
    sections.push(table.sql);
    sections.push('');
    if (table.rows.length === 0) {
      sections.push('(no changes)\n');
    } else {
      sections.push(formatMarkdownTable(table.rows));
      sections.push('');
    }
  }
  return sections.join('\n');
}

/**
 * Returns true if any of the given DbChangeTable objects contain rows.
 */
function dbTablesHaveRows(tables: DbChangeTable[]): boolean {
  return tables.some((t) => t.rows.length > 0);
}

/**
 * Check if collected activity data contains any meaningful content.
 */
function hasActivity(agentActivity: string, dbTables: DbChangeTable[]): boolean {
  const hasAgentLines = !agentActivity
    .split('\n')
    .every((line) => !line.trim() || line.startsWith('###') || line === '(no activity)');
  return hasAgentLines || dbTablesHaveRows(dbTables);
}

/**
 * Advance last_narrator_update_ts in the daily summary file and all project log files.
 * Each file is committed individually (best-effort) for version tracking.
 */
function advanceFrontmatterCursors(
  dailySummaryPath: string,
  projectDataList: ProjectActivityData[],
  newRunTs: string
): void {
  writeFrontmatterField(dailySummaryPath, 'last_narrator_update_ts', newRunTs);
  commitIfStateDir(dailySummaryPath, `cursor: ${basename(dailySummaryPath)}`);
  for (const pd of projectDataList) {
    if (pd.logFile) {
      writeFrontmatterField(pd.logFile, 'last_narrator_update_ts', newRunTs);
      commitIfStateDir(pd.logFile, `cursor: ${pd.projectName} log`);
    }
  }
}

/**
 * Build and deliver project logs and daily summary to the Narrator.
 *
 * For each active project (conductor not archived), a project-log message is
 * delivered first with all involved agents' activity (project-scoped + Guide)
 * and project-scoped DB changes. The collected data is then reused
 * in the daily summary, which groups activity by project vs non-project.
 *
 * Shared by both the cron handler and server catch-up.
 */
export async function buildAndDeliverDailySummary(
  db: DatabaseClient,
  narratorHost: AgentHost,
  narratorId: number,
  system2Dir: string,
  intervalMinutes: number,
  catchUpBudgetBytes: number = CATCH_UP_BUDGET_BYTES,
  narratorMessageExcerptBytes: number = NARRATOR_MESSAGE_EXCERPT_BYTES
): Promise<void> {
  // Reclaim the session if a prior cycle left it oversized, before it grows past the context window.
  await narratorHost.reclaimBloatedSession();

  const newRunTs = new Date().toISOString();
  const today = newRunTs.slice(0, 10);
  const summariesDir = join(system2Dir, 'knowledge', 'daily_summaries');
  const filePath = join(summariesDir, `${today}.md`);

  // Per-tick cache; keyed by agent id only since agent.project_name is stable within one tick.
  const sessionEntryCache = new Map<string, TimestampedEntry[]>();

  // Ensure directory exists
  if (!existsSync(summariesDir)) {
    mkdirSync(summariesDir, { recursive: true });
  }

  // 1. Create today's file if needed
  if (!existsSync(filePath)) {
    writeFileSync(
      filePath,
      `---\nlast_narrator_update_ts:\n---\n# Daily Summary — ${today}\n`,
      'utf-8'
    );
  }

  // 2. Resolve last_run_ts
  let lastRunTs = readFrontmatterField(filePath, 'last_narrator_update_ts');
  if (!lastRunTs) {
    lastRunTs = getMostRecentSummaryTimestamp(summariesDir);
  }
  if (!lastRunTs) {
    const memoryPath = join(system2Dir, 'knowledge', 'memory.md');
    lastRunTs = readFrontmatterField(memoryPath, 'last_narrator_update_ts');
  }
  if (!lastRunTs) {
    // If daily summary files already exist, the server should have written
    // last_narrator_update_ts to their frontmatter after delivery. Missing
    // timestamps indicate a problem (e.g., server crashed before cursor update).
    const hasExistingSummaries =
      existsSync(summariesDir) &&
      readdirSync(summariesDir).some((f) => f.endsWith('.md') && f !== `${today}.md`);
    if (hasExistingSummaries) {
      throw new Error(
        'daily summary files exist but last_narrator_update_ts not found in any frontmatter or memory.md'
      );
    }
    // First run: no prior summaries, fall back to interval window
    lastRunTs = new Date(Date.now() - intervalMinutes * 60_000).toISOString();
  }

  // 4. Get all non-archived agents and partition by scope
  const allAgents = db.query(
    "SELECT a.id, a.role, p.name as project_name FROM agent a LEFT JOIN project p ON a.project = p.id WHERE a.status != 'archived'"
  ) as AgentRow[];

  // For project logs: system-wide agents excluding Narrator (Guide only)
  const projectLogSystemAgents = allAgents.filter(
    (a) => a.project_name === null && a.id !== narratorId
  );
  // For daily summary non-project section: system-wide agents excluding Narrator
  // (including Narrator would create a feedback loop: its own custom_messages
  // get collected as "agent activity" and nested inside the next injection,
  // causing exponential growth)
  const dailySummarySystemAgents = allAgents.filter(
    (a) => a.project_name === null && a.id !== narratorId
  );

  // 5. Find active projects (conductor not archived) and deliver project logs
  const activeProjects = db.query(
    `SELECT DISTINCT p.id, p.name, p.dir_name FROM project p
     JOIN agent a ON a.project = p.id
     WHERE a.role = 'conductor' AND a.status != 'archived'`
  ) as Array<{ id: number; name: string; dir_name: string | null }>;

  const projectDataList: ProjectActivityData[] = [];
  // Track each delivery's label so a rejection log / aggregated error can
  // identify which payload failed (e.g. 'project-log:42:Foo' vs 'daily-summary')
  // when multiple deliveries reject in the same tick. Includes project.id
  // because `project.name` has no UNIQUE constraint in the schema, so two
  // projects can share a name.
  const deliveries: Array<{ label: string; promise: Promise<void> }> = [];

  for (const project of activeProjects) {
    // Use persisted dir_name, falling back to resolveProjectDir for legacy projects
    const dirName =
      project.dir_name ??
      basename(resolveProjectDir(join(system2Dir, 'projects'), project.id, project.name));
    const projectDir = join(system2Dir, 'projects', dirName);
    mkdirSync(join(projectDir, 'artifacts'), { recursive: true });
    mkdirSync(join(projectDir, 'scratchpad'), { recursive: true });
    const logFile = join(projectDir, 'log.md');

    // Create log file if needed
    if (!existsSync(logFile)) {
      writeFileSync(
        logFile,
        `---\nlast_narrator_update_ts:\nproject_id: ${project.id}\nproject_name: ${project.name}\n---\n`,
        'utf-8'
      );
    }

    // Project-scoped agents (Conductor, Reviewer, specialists)
    const projectScopedAgents = allAgents.filter(
      (a) => a.project_name === project.name
    ) as AgentRow[];

    // All agents involved: project-scoped + Guide (for project log)
    const allProjectAgents = [...projectScopedAgents, ...projectLogSystemAgents];

    const allProjectAgentEntries = collectAgentActivityWithTimestamps(
      system2Dir,
      allProjectAgents,
      lastRunTs,
      newRunTs,
      narratorMessageExcerptBytes,
      sessionEntryCache
    );
    const projectDbTables = collectProjectDbChanges(db, project.id, lastRunTs, newRunTs);

    // Collect project-scoped entries to determine whether this project has activity
    const projectScopedEntries = collectAgentActivityWithTimestamps(
      system2Dir,
      projectScopedAgents,
      lastRunTs,
      newRunTs,
      narratorMessageExcerptBytes,
      sessionEntryCache
    );
    projectDataList.push({
      projectId: project.id,
      projectName: project.name,
      logFile,
      dbTables: projectDbTables,
      hasChanges: projectScopedEntries.length > 0 || dbTablesHaveRows(projectDbTables),
    });

    // Deliver project-log message (with all agents including Guide)
    const allProjectAgentActivity = renderAgentActivitySections(
      system2Dir,
      allProjectAgents,
      lastRunTs,
      newRunTs,
      allProjectAgentEntries,
      narratorMessageExcerptBytes
    );
    if (!hasActivity(allProjectAgentActivity, projectDbTables)) continue;

    // Apply catch-up budget to the agent activity entries for this project-log delivery.
    // Build a fixed header to measure how much space it occupies so the budget applies
    // only to the variable activity section.
    const projectLogHeader = `[Scheduled task: project-log]

project_id: ${project.id}
project_name: ${project.name}
file: ${logFile}
last_run_ts: ${lastRunTs}
new_run_ts: ${newRunTs}

IMPORTANT: Do not message the Guide when you are done. This is a background task — no response is expected.`;

    // Apply DB-changes budget (25% of total) before computing activity budget.
    const projectDbBudget = Math.floor(catchUpBudgetBytes * DB_CHANGES_BUDGET_FRACTION);
    const projectDbTruncation = truncateDbChangesToFit(projectDbTables, projectDbBudget);

    const projectLogOverhead =
      Buffer.byteLength(projectLogHeader, 'utf8') +
      Buffer.byteLength(projectDbTruncation.rendered, 'utf8') +
      200; // 200 for section labels/separators
    const projectLogActivityBudget = Math.max(catchUpBudgetBytes - projectLogOverhead, 0);
    const projectLogTruncation = truncateOldestToFit(
      allProjectAgentEntries,
      projectLogActivityBudget
    );
    if (projectLogTruncation.droppedCount > 0 && projectLogTruncation.droppedRange) {
      log.warn(
        `[Scheduler] Truncated ${projectLogTruncation.droppedCount} oldest activity entries spanning ` +
          `${projectLogTruncation.droppedRange.from} → ${projectLogTruncation.droppedRange.to} ` +
          `from project ${project.name} delivery to fit ${catchUpBudgetBytes.toLocaleString()}-byte budget`
      );
    }
    if (projectDbTruncation.droppedTotal > 0 && projectDbTruncation.droppedRanges.length > 0) {
      const summary = projectDbTruncation.droppedRanges
        .map((r) => `${r.count} from ${r.table}`)
        .join(', ');
      log.warn(
        `[Scheduler] Truncated DB-change rows from project ${project.name} delivery: ${summary} (budget=${projectDbBudget.toLocaleString()} bytes)`
      );
    }
    const truncatedProjectActivity = renderAgentActivitySections(
      system2Dir,
      allProjectAgents,
      lastRunTs,
      newRunTs,
      projectLogTruncation.kept,
      narratorMessageExcerptBytes
    );
    const projectLogAnnotation = annotateTruncation(projectLogTruncation, projectLogActivityBudget);

    const projectLogMessage = `${projectLogHeader}${projectLogAnnotation}
## Agent Activity

${truncatedProjectActivity}
## Database Changes

${projectDbTruncation.rendered}`;

    deliveries.push({
      label: `project-log:${project.id}:${project.name}`,
      promise: narratorHost.deliverMessage(projectLogMessage, {
        sender: 0,
        receiver: narratorId,
        timestamp: Date.now(),
      }),
    });
  }

  // 6. Build daily summary — grouped by project vs non-project
  const activeProjectIds = projectDataList.map((p) => p.projectId);

  // Non-project: Guide + Narrator JSONL (full streams, span all projects)
  const nonProjectAgentEntries = collectAgentActivityWithTimestamps(
    system2Dir,
    dailySummarySystemAgents,
    lastRunTs,
    newRunTs,
    narratorMessageExcerptBytes,
    sessionEntryCache
  );
  const nonProjectAgentActivity = renderAgentActivitySections(
    system2Dir,
    dailySummarySystemAgents,
    lastRunTs,
    newRunTs,
    nonProjectAgentEntries,
    narratorMessageExcerptBytes
  );
  const nonProjectDbTables = collectNonProjectDbChanges(db, activeProjectIds, lastRunTs, newRunTs);

  // 7. Check for any activity at all
  const hasProjectChanges = projectDataList.some((pd) => pd.hasChanges);
  const hasNonProjectChanges = hasActivity(nonProjectAgentActivity, nonProjectDbTables);

  if (!hasProjectChanges && !hasNonProjectChanges) {
    // Advance cursor even on skip to prevent re-scanning an empty window
    advanceFrontmatterCursors(filePath, projectDataList, newRunTs);
    throw new JobSkipped('no activity since last run');
  }

  // 8. Assemble daily summary message (only sections with activity)
  const dailySummaryHeader = `[Scheduled task: daily-summary]

file: ${filePath}
last_run_ts: ${lastRunTs}
new_run_ts: ${newRunTs}

IMPORTANT: Do not message the Guide when you are done. This is a background task — no response is expected.`;

  // Apply DB-changes budget (25% of total) to each section independently.
  const summaryDbBudget = Math.floor(catchUpBudgetBytes * DB_CHANGES_BUDGET_FRACTION);
  // Split the summary DB budget evenly across active project sections + non-project section.
  const summaryDbSectionCount = projectDataList.filter((pd) => pd.hasChanges).length + 1;
  const perSectionDbBudget = Math.floor(summaryDbBudget / Math.max(summaryDbSectionCount, 1));

  // Only build/render DB truncations for projects that will actually contribute a section
  // (pd.hasChanges). Including projects with no changes inflates summaryDbRenderedSize, which
  // shrinks the activity budget and causes unnecessary activity truncation.
  const projectDbTruncations = new Map<number, DbTruncateResult>();
  for (const pd of projectDataList) {
    if (!pd.hasChanges) continue;
    const result = truncateDbChangesToFit(pd.dbTables, perSectionDbBudget);
    projectDbTruncations.set(pd.projectId, result);
    if (result.droppedTotal > 0 && result.droppedRanges.length > 0) {
      const summary = result.droppedRanges.map((r) => `${r.count} from ${r.table}`).join(', ');
      log.warn(
        `[Scheduler] Truncated DB-change rows from project ${pd.projectName} daily summary: ${summary} (budget=${perSectionDbBudget.toLocaleString()} bytes)`
      );
    }
  }
  const nonProjectDbTruncation = truncateDbChangesToFit(nonProjectDbTables, perSectionDbBudget);
  if (nonProjectDbTruncation.droppedTotal > 0 && nonProjectDbTruncation.droppedRanges.length > 0) {
    const summary = nonProjectDbTruncation.droppedRanges
      .map((r) => `${r.count} from ${r.table}`)
      .join(', ');
    log.warn(
      `[Scheduler] Truncated DB-change rows from non-project daily summary delivery: ${summary} (budget=${perSectionDbBudget.toLocaleString()} bytes)`
    );
  }

  // Compute overhead: header + bounded DB changes + static section labels (generous estimate)
  const summaryDbRenderedSize =
    [...projectDbTruncations.values()].reduce(
      (s, r) => s + Buffer.byteLength(r.rendered, 'utf8'),
      0
    ) + Buffer.byteLength(nonProjectDbTruncation.rendered, 'utf8');
  const summaryOverhead =
    Buffer.byteLength(dailySummaryHeader, 'utf8') + summaryDbRenderedSize + 500;
  const summaryActivityBudget = Math.max(catchUpBudgetBytes - summaryOverhead, 0);

  // Gather all project-scoped entries for truncation
  const allProjectScopedEntries: TimestampedEntry[] = projectDataList.flatMap((pd) =>
    collectAgentActivityWithTimestamps(
      system2Dir,
      allAgents.filter((a) => a.project_name === pd.projectName),
      lastRunTs,
      newRunTs,
      narratorMessageExcerptBytes,
      sessionEntryCache
    )
  );
  const allActivityEntries = [...allProjectScopedEntries, ...nonProjectAgentEntries];
  const summaryTruncation = truncateOldestToFit(allActivityEntries, summaryActivityBudget);
  if (summaryTruncation.droppedCount > 0 && summaryTruncation.droppedRange) {
    log.warn(
      `[Scheduler] Truncated ${summaryTruncation.droppedCount} oldest activity entries spanning ` +
        `${summaryTruncation.droppedRange.from} → ${summaryTruncation.droppedRange.to} ` +
        `from combined daily summary activity to fit ${catchUpBudgetBytes.toLocaleString()}-byte budget`
    );
  }
  const summaryAnnotation = annotateTruncation(summaryTruncation, summaryActivityBudget);

  const messageParts: string[] = [
    summaryAnnotation ? `${dailySummaryHeader}${summaryAnnotation}` : dailySummaryHeader,
  ];

  const activeProjectParts: string[] = [];
  for (const pd of projectDataList) {
    if (!pd.hasChanges) continue;
    // Render this project's activity using only kept entries
    const projectAgents = allAgents.filter((a) => a.project_name === pd.projectName);
    const renderedProjectActivity = renderAgentActivitySections(
      system2Dir,
      projectAgents,
      lastRunTs,
      newRunTs,
      summaryTruncation.kept,
      narratorMessageExcerptBytes
    );
    const pdDbResult = projectDbTruncations.get(pd.projectId) ?? {
      rendered: renderDbChangeTables(pd.dbTables),
      droppedTotal: 0,
      droppedRanges: [],
    };
    activeProjectParts.push(
      `### Project: ${pd.projectName} (#${pd.projectId})\n\n#### Agent Activity\n\n${renderedProjectActivity}\n#### Database Changes\n\n${pdDbResult.rendered}`
    );
  }
  if (activeProjectParts.length > 0) {
    messageParts.push(`## Project Activity\n\n${activeProjectParts.join('\n')}`);
  }

  if (hasNonProjectChanges) {
    const renderedNonProjectActivity = renderAgentActivitySections(
      system2Dir,
      dailySummarySystemAgents,
      lastRunTs,
      newRunTs,
      summaryTruncation.kept,
      narratorMessageExcerptBytes
    );
    messageParts.push(
      `## Non-Project Activity\n\n#### Agent Activity\n\n${renderedNonProjectActivity}\n#### Database Changes\n\n${nonProjectDbTruncation.rendered}`
    );
  }

  // 9. Deliver daily summary
  deliveries.push({
    label: 'daily-summary',
    promise: narratorHost.deliverMessage(messageParts.join('\n\n'), {
      sender: 0,
      receiver: narratorId,
      timestamp: Date.now(),
    }),
  });

  // Wait for the Narrator to finish processing all deliveries. Use allSettled
  // (not Promise.all) so every rejection is consumed: when two or more
  // deliveries reject in the same tick — e.g. handlePotentialError's
  // contamination short-circuit aborts all pending deliveries on a mid-turn
  // API error — Promise.all surfaces only the first, and Node promotes the
  // rest to unhandledRejection → process exit.
  const results = await Promise.allSettled(deliveries.map((d) => d.promise));
  const failures: Array<{ label: string; reason: unknown }> = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      failures.push({ label: deliveries[i].label, reason: r.reason });
    }
  });
  if (failures.length > 0) {
    for (const failure of failures) {
      log.error(`[Scheduler] daily-summary delivery failed (${failure.label}):`, failure.reason);
    }
    // All-or-nothing: do not advance frontmatter cursors on partial failure;
    // the next cron tick retries from the same lastRunTs.
    //
    // AggregateError.stack only shows the aggregator's own frames, not the
    // per-delivery reasons; trackJobExecution stores `error.stack ?? message`
    // on the job_execution row's `error` column, so without flattening, the
    // DB record would only show "N/M deliveries failed" with no clue what
    // went wrong or which delivery. Fold each rejection's label + message
    // into the aggregate message so it ends up in job_execution.error
    // alongside the per-failure log lines.
    const reasonSummary = failures
      .map((f) => `${f.label}: ${f.reason instanceof Error ? f.reason.message : String(f.reason)}`)
      .join('; ');
    throw new AggregateError(
      failures.map((f) => f.reason),
      `${failures.length}/${results.length} daily-summary deliveries failed: ${reasonSummary}`
    );
  }

  // Server-side cursor advancement: update frontmatter so the next cron run
  // starts from newRunTs. Previously delegated to the LLM, but compaction
  // could wipe the instruction, causing stale cursors and repeated deliveries.
  advanceFrontmatterCursors(filePath, projectDataList, newRunTs);
}

/**
 * Thrown by job handlers to signal a deliberate skip (no work to do).
 * The execution is recorded with status 'skipped' and the reason stored.
 */
export class JobSkipped extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = 'JobSkipped';
  }
}

/**
 * Default upper bound for any single job handler invocation. Healthy daily-summary
 * and memory-update runs complete in well under a minute; anything pushing past 10
 * minutes is presumed wedged (see issue #194 for the silent-hang failure mode this
 * flags). Overridable per call via the `timeoutMs` parameter.
 *
 * Not preemptive: this is a *reporting* bound, not a cancellation mechanism. The
 * timer runs on the same event loop as the handler, so a wedge that starves the
 * loop starves the timer too (issue #203). trackJobExecution enforces the bound
 * as a wall-clock check at settlement time, so the failure signature is honest
 * even when the setTimeout could not fire on schedule. Preemption would require
 * a Worker thread or wiring AbortSignal down to the wedge-prone code path.
 */
export const DEFAULT_HANDLER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How far past the deadline an observed elapsed measurement must sit before the
 * error message calls it out as event-loop starvation. Node's `setTimeout`
 * callbacks fire a few ms late even on a healthy loop; without a tolerance,
 * every clean timer-fire would carry the "loop was starved" suffix and drown
 * real starvation events in ordinary jitter.
 */
export const STARVATION_TOLERANCE_MS = 100;

/**
 * Format an underlying error for embedding in a HandlerTimeoutError message.
 * For AggregateError, flattens each nested `.errors[]` message alongside the
 * outer header so the DB row preserves per-delivery reasons (which the caller
 * would otherwise have to re-serialize into the AggregateError message itself).
 */
function formatCauseForMessage(cause: unknown): string {
  if (cause instanceof AggregateError) {
    const parts = cause.errors.map((e) => (e instanceof Error ? e.message : String(e)));
    return parts.length > 0 ? `${cause.message} [${parts.join('; ')}]` : cause.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Thrown by trackJobExecution when a handler exceeds its timeout. The handler's
 * own promise is left to settle on its own (we cannot cancel arbitrary user code),
 * but the execution row is marked `failed` immediately so the scheduler is no
 * longer blocked.
 *
 * Two paths produce this error, both handled uniformly by the constructor:
 *   1. The `setTimeout` in trackJobExecution fires and wins the `Promise.race`.
 *      `elapsedMs` is close to `deadlineMs` (within `STARVATION_TOLERANCE_MS`),
 *      the message stays "handler timed out after Xs".
 *   2. The event loop was starved past the deadline (issue #203). The `setTimeout`
 *      fires late or after the handler settles, so the handler's own rejection
 *      wins the race. trackJobExecution then re-checks wall-clock at completion,
 *      and if the deadline was breached, coerces to this type. `elapsedMs`
 *      exceeds `deadlineMs` by more than `STARVATION_TOLERANCE_MS`, and the
 *      message becomes "handler timed out after Xs (deadline Ys; event loop was
 *      starved past the timer); handler eventually rejected: …" so the failure
 *      signature is unambiguous.
 *
 * Uses the ES2022 `Error({ cause })` idiom so `util.inspect`, `console.error`,
 * and standard error-chain traversal automatically follow the underlying reason.
 * `underlyingError` is retained as a getter over `.cause` for backward
 * compatibility with callers that read the bespoke field name.
 *
 * The message uses `Math.ceil` on the seconds conversion so sub-second timeouts
 * never render as `0s`.
 */
export class HandlerTimeoutError extends Error {
  public readonly elapsedMs: number;
  public readonly deadlineMs: number;
  public readonly starved: boolean;

  constructor(elapsedMs: number, deadlineMs: number, cause?: unknown) {
    const starved = elapsedMs > deadlineMs + STARVATION_TOLERANCE_MS;
    // Report the deadline (not observed elapsed) when the timer fired within
    // normal jitter — otherwise a healthy 600 s timeout that overshoots by 3 ms
    // reads as "601s". Report the actual elapsed only when the loop was clearly
    // starved past the deadline.
    const displayMs = starved ? elapsedMs : deadlineMs;
    const displaySec = Math.ceil(displayMs / 1000);
    const deadlineSec = Math.ceil(deadlineMs / 1000);
    let msg = `handler timed out after ${displaySec}s`;
    if (starved) {
      msg += ` (deadline ${deadlineSec}s; event loop was starved past the timer)`;
    }
    if (cause !== undefined) {
      msg += `; handler eventually rejected: ${formatCauseForMessage(cause)}`;
    }
    // ES2022 cause option — Node's util.inspect / console.error render this as
    // "[cause]:" chained under the primary error, so downstream logs, error
    // aggregators, and the Croner uncaught-handler log all get the underlying
    // stack automatically without a bespoke serializer.
    super(msg, cause !== undefined ? { cause } : undefined);
    this.name = 'HandlerTimeoutError';
    this.elapsedMs = elapsedMs;
    this.deadlineMs = deadlineMs;
    this.starved = starved;
  }

  /**
   * Backward-compatible getter for the pre-#203 `underlyingError` field name.
   * Returns the ES2022 `cause` so existing readers of `err.underlyingError`
   * keep working.
   */
  get underlyingError(): unknown {
    return this.cause;
  }
}

/**
 * Options accepted by trackJobExecution.
 *
 * Kept as an object so callers that want a custom `timeoutMs` do not have to
 * pass an `undefined` placeholder for `onJobChange`, and so new options can be
 * added without re-ordering positional arguments.
 */
export interface TrackJobExecutionOptions {
  /** Fired whenever the execution row transitions to a new status. */
  onJobChange?: () => void;
  /** Override the default handler timeout. */
  timeoutMs?: number;
}

/**
 * Execute a job with execution tracking: inserts a 'running' record,
 * calls the handler, then marks it 'completed', 'skipped', or 'failed'.
 *
 * `timeoutMs` bounds how long the handler may run before the row is force-failed.
 * The handler promise itself is detached on timeout (its eventual settlement is
 * swallowed so it cannot surface as an unhandled rejection); this is intentional,
 * since the failure mode the timeout exists for is a handler that never resolves.
 */
export async function trackJobExecution(
  db: DatabaseClient,
  jobName: string,
  triggerType: JobExecution['trigger_type'],
  handler: () => void | Promise<void>,
  opts: TrackJobExecutionOptions = {}
): Promise<void> {
  const { onJobChange, timeoutMs = DEFAULT_HANDLER_TIMEOUT_MS } = opts;
  // Reject invalid timeouts up front. NaN would silently disable the wall-clock
  // check (`elapsedMs > NaN` is always false); non-positive values would coerce
  // every handler. Fail loudly at the boundary rather than silently produce
  // meaningless timeout messages downstream.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(
      `trackJobExecution: timeoutMs must be a positive finite number, got ${timeoutMs}`
    );
  }
  const execution = db.createJobExecution(jobName, triggerType);
  const notifyChange = () => {
    try {
      onJobChange?.();
    } catch {
      // Best-effort notification: job tracking must not break due to callback failure.
    }
  };
  notifyChange();

  // Wall-clock elapsed (issue #203). `Date.now()` is used rather than
  // `performance.now()` for testability: vitest's default `useFakeTimers`
  // mocks `Date` and honors `vi.setSystemTime()`, but not `performance.now()`,
  // so tests could not simulate the starved-loop scenario the fix exists for.
  // Trade-off: a wall-clock jump (NTP correction, laptop sleep/resume) mid-
  // handler can shift `elapsedMs` in either direction. Small NTP corrections
  // (< STARVATION_TOLERANCE_MS) are absorbed by the tolerance; the sleep-
  // during-handler case can produce a misleading "starved" message but the
  // row itself is still classified correctly (a resolved handler stays
  // completed; only a rejected handler is coerced to failed).
  const startedAtMs = Date.now();
  const elapsedMs = (): number => Date.now() - startedAtMs;
  let timerFired = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const handlerPromise = Promise.resolve().then(handler);
  // Attach a rejection handler at creation time so a post-race rejection is
  // "handled" per Promise semantics (Node's unhandledRejection guard would
  // otherwise fire for a late rejection whose only observer, Promise.race,
  // has already settled). Log the underlying rejection when it lands past the
  // deadline: either the timer already fired first (`timerFired`) or the loop
  // was starved and the handler settled inside the wall-clock window that
  // already breached (issue #203) — in both cases the DB row and the timeout
  // message have already been recorded, and this log entry captures the
  // handler's own stack in the daemon log so post-mortems can see where the
  // wedge actually rejected.
  handlerPromise.catch((late) => {
    if (timerFired || elapsedMs() > timeoutMs) {
      log.warn(`[Jobs] ${jobName} handler eventually rejected past deadline:`, late);
    }
  });
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timerFired = true;
      // Pass measured elapsed; HandlerTimeoutError applies STARVATION_TOLERANCE_MS
      // internally so healthy timer jitter does NOT get labelled as starvation.
      reject(new HandlerTimeoutError(elapsedMs(), timeoutMs));
    }, timeoutMs);
  });

  // Local helper: write the row and forward the notification exactly once. All
  // failure branches route through this so the pre-#206 invariant "each execution
  // row is written to exactly once after the initial `running` insert" is
  // preserved even when the wall-clock coerce fires on top of the timer race.
  const failAndThrow = (message: string, toThrow: unknown): never => {
    db.failJobExecution(execution.id, message);
    notifyChange();
    throw toThrow;
  };

  try {
    await Promise.race([handlerPromise, timeoutPromise]);
    // Success path: handler resolved. Even if elapsed exceeded the deadline
    // (event-loop starvation cleared before the wedge could reject), the
    // handler's side effects have already committed — e.g. buildAndDeliverDailySummary
    // calls advanceFrontmatterCursors before returning. Coercing this row to
    // `failed` would desync the row status from the disk state; the doc
    // invariant "if a job fails, the cursor stays stale" would be violated
    // and the next restart would not re-run the delivery. Log a warning so
    // the overrun is still visible, but the row stays `completed`.
    const observedMs = elapsedMs();
    if (observedMs > timeoutMs) {
      log.warn(
        `[Jobs] ${jobName} handler completed after ${Math.ceil(observedMs / 1000)}s ` +
          `(deadline ${Math.ceil(timeoutMs / 1000)}s); side effects were committed, ` +
          `row recorded as completed`
      );
    }
    db.completeJobExecution(execution.id);
    notifyChange();
  } catch (error) {
    const observedMs = elapsedMs();
    // 1. Timer-fired HandlerTimeoutError from Promise.race. Message already
    //    embeds elapsed / deadline / starvation tolerance; write once and
    //    rethrow.
    if (error instanceof HandlerTimeoutError) {
      failAndThrow(error.stack ?? error.message, error);
    }
    // 2. Wall-clock coerce (issue #203). Elapsed past the deadline overrides
    //    all other error categories — including JobSkipped, because a "skip"
    //    that took 15 minutes is by definition a wedge, not a healthy skip.
    //    Coerce to HandlerTimeoutError with the original error as `cause` so
    //    downstream error-chain traversal (util.inspect, Error.stack in Node
    //    22+) still surfaces the underlying reason. Write once and rethrow.
    if (observedMs > timeoutMs) {
      const coerced = new HandlerTimeoutError(observedMs, timeoutMs, error);
      // Preserve the underlying stack in the DB row too. HandlerTimeoutError's
      // own .stack does not include the cause chain (Node's Error.stack getter
      // only prints the top-level frames), so we append the underlying stack
      // explicitly. Post-mortems reading the row directly (not via
      // util.inspect) still see where the wedge originated.
      const underlyingTrace =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      const dbMessage = `${coerced.stack ?? coerced.message}\nCaused by: ${underlyingTrace}`;
      failAndThrow(dbMessage, coerced);
    }
    // 3. Handler explicitly signaled a skip within the deadline.
    if (error instanceof JobSkipped) {
      db.skipJobExecution(execution.id, error.reason);
      notifyChange();
      return;
    }
    // 4. Ordinary handler failure within the deadline.
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    failAndThrow(message, error);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Register all Narrator scheduled jobs.
 */
export function registerNarratorJobs(
  scheduler: Scheduler,
  narratorHost: AgentHost,
  narratorId: number,
  db: DatabaseClient,
  system2Dir: string,
  intervalMinutes: number,
  knowledgeBudgetChars?: number,
  onJobChange?: () => void,
  catchUpBudgetBytes: number = CATCH_UP_BUDGET_BYTES,
  narratorMessageExcerptBytes: number = NARRATOR_MESSAGE_EXCERPT_BYTES
): void {
  // Daily summary — configurable interval
  const cronPattern = 60 % intervalMinutes === 0 ? `*/${intervalMinutes} * * * *` : '*/30 * * * *';

  scheduler.schedule('daily-summary', cronPattern, async () => {
    await trackJobExecution(
      db,
      'daily-summary',
      'cron',
      async () => {
        if (!(await isNetworkAvailable())) {
          throw new JobSkipped('no network connectivity');
        }
        log.info('[Scheduler] Triggering daily-summary job (project logs + daily summary)');
        await buildAndDeliverDailySummary(
          db,
          narratorHost,
          narratorId,
          system2Dir,
          intervalMinutes,
          catchUpBudgetBytes,
          narratorMessageExcerptBytes
        );
      },
      { onJobChange }
    );
  });

  // Memory update — daily at 11 AM
  scheduler.schedule('memory-update', '0 11 * * *', async () => {
    await trackJobExecution(
      db,
      'memory-update',
      'cron',
      async () => {
        if (!(await isNetworkAvailable())) {
          throw new JobSkipped('no network connectivity');
        }
        log.info('[Scheduler] Triggering memory-update job');
        await buildAndDeliverMemoryUpdate(
          narratorHost,
          narratorId,
          system2Dir,
          knowledgeBudgetChars,
          catchUpBudgetBytes,
          narratorMessageExcerptBytes
        );
      },
      { onJobChange }
    );
  });
}

/**
 * Build and deliver a memory-update message to the Narrator.
 * Shared by both the cron handler and server catch-up.
 */
export async function buildAndDeliverMemoryUpdate(
  narratorHost: AgentHost,
  narratorId: number,
  system2Dir: string,
  knowledgeBudgetChars = 20_000,
  catchUpBudgetBytes: number = CATCH_UP_BUDGET_BYTES,
  narratorMessageExcerptBytes: number = NARRATOR_MESSAGE_EXCERPT_BYTES
): Promise<void> {
  // Reclaim the session if a prior cycle left it oversized (see buildAndDeliverDailySummary).
  await narratorHost.reclaimBloatedSession();

  knowledgeBudgetChars = Math.max(knowledgeBudgetChars, 5_000);
  const newRunTs = new Date().toISOString();
  const memoryFile = join(system2Dir, 'knowledge', 'memory.md');
  const summariesDir = join(system2Dir, 'knowledge', 'daily_summaries');
  const knowledgeDir = join(system2Dir, 'knowledge');

  // Read last_narrator_update_ts from memory.md
  const lastTs = readFrontmatterField(memoryFile, 'last_narrator_update_ts');
  const lastDate = lastTs ? lastTs.slice(0, 10) : '1970-01-01';

  // List daily summaries since lastDate (inclusive)
  const summaryFiles = existsSync(summariesDir)
    ? readdirSync(summariesDir)
        .filter((f) => f.endsWith('.md'))
        .filter((f) => f.replace('.md', '') >= lastDate)
        .sort()
        .map((f) => join(summariesDir, f))
    : [];

  // Identify knowledge files (excluding memory.md) that exceed the budget
  const oversizedFiles = (
    existsSync(knowledgeDir)
      ? readdirSync(knowledgeDir)
          .filter((f) => f.endsWith('.md') && f !== 'memory.md')
          .map((f) => ({
            path: join(knowledgeDir, f),
            content: readFileSync(join(knowledgeDir, f), 'utf-8'),
          }))
      : []
  ).filter(({ content }) => content.length > knowledgeBudgetChars);

  if (summaryFiles.length === 0 && oversizedFiles.length === 0) {
    throw new JobSkipped('no daily summaries to incorporate and no oversized knowledge files');
  }

  const messageParts: string[] = [];

  let summaryAnnotation = '';

  if (summaryFiles.length > 0) {
    // Convert each summary file to a TimestampedEntry for oldest-first truncation.
    // The timestamp is the date in the filename (e.g. "2026-03-10" from "2026-03-10.md").
    const summaryEntryObjects: TimestampedEntry[] = summaryFiles.map((f, i) => {
      const content = readFileSync(f, 'utf-8');
      const filename = basename(f);
      const timestamp = filename.replace('.md', '');
      return {
        id: `daily_summary:${filename}:${i}`,
        timestamp,
        rendered: `### ${filename}\n\n${content}`,
        agentLabel: 'daily_summary',
      };
    });

    // Compute how much of the budget the fixed header occupies so the truncation budget
    // applies only to the variable daily-summary section.
    const fixedHeader = `[Scheduled task: memory-update]

memory_file: ${memoryFile}
last_narrator_update_ts: ${lastTs ?? '(none)'}
new_run_ts: ${newRunTs}

IMPORTANT: Do not message the Guide when you are done. This is a background task — no response is expected.`;
    const sectionLabel = '## Daily summaries to incorporate\n\n';
    const headerOverhead =
      Buffer.byteLength(fixedHeader, 'utf8') + Buffer.byteLength(sectionLabel, 'utf8') + 200; // 200 for separators/join
    const summaryBudget = Math.max(catchUpBudgetBytes - headerOverhead, 0);

    const truncation = truncateOldestToFit(summaryEntryObjects, summaryBudget);

    if (truncation.droppedCount > 0 && truncation.droppedRange) {
      log.warn(
        `[Scheduler] Truncated ${truncation.droppedCount} oldest daily summary files spanning ` +
          `${truncation.droppedRange.from} → ${truncation.droppedRange.to} ` +
          `from memory-update delivery to fit ${catchUpBudgetBytes.toLocaleString()}-byte budget`
      );
      summaryAnnotation =
        `\n\n[NOTE: dropped ${truncation.droppedCount} oldest daily summary files spanning ` +
        `${truncation.droppedRange.from} → ${truncation.droppedRange.to} ` +
        `to fit ${catchUpBudgetBytes.toLocaleString()}-byte delivery budget]\n\n`;
    }

    // Render kept entries (already sorted oldest-first by truncateOldestToFit)
    if (truncation.kept.length > 0) {
      messageParts.push(`${sectionLabel}${truncation.kept.map((e) => e.rendered).join('\n\n')}`);
    }
  }

  if (oversizedFiles.length > 0) {
    // Cap each condensation entry's inlined content to 4× the per-message excerpt budget
    // (default: 4 × 16 KB = 64 KB). A single huge file must not blow the delivery budget.
    // For append-only knowledge files the tail is newest, so we keep the LAST N bytes and
    // drop the head; the truncation marker is placed at the START of the inlined content.
    const condensationInlineCap = narratorMessageExcerptBytes * 4;
    const condensationItems = oversizedFiles.map(({ path: f, content }) => {
      const label = f.replace(system2Dir, '~/.system2');
      const overage = content.length - knowledgeBudgetChars;
      let inlinedContent = content;
      let truncationMarker = '';
      if (Buffer.byteLength(content, 'utf8') > condensationInlineCap) {
        // Keep the tail: slice from the end and trim to a byte boundary if needed.
        let sliced = content.slice(-condensationInlineCap);
        while (Buffer.byteLength(sliced, 'utf8') > condensationInlineCap) {
          sliced = sliced.slice(1);
        }
        inlinedContent = sliced;
        truncationMarker = `[truncated: head dropped — file exceeds ${condensationInlineCap.toLocaleString()}-byte inline cap — use \`read\` tool to see the full file]\n\n`;
      }
      const rendered = `### ${label}\n\nCurrent size: ${content.length.toLocaleString()} chars (+${overage.toLocaleString()} over ${knowledgeBudgetChars.toLocaleString()} char budget)\n\n${truncationMarker}${inlinedContent}`;
      return { path: f, label, rendered };
    });

    // Apply a collective cap so the condensation section (sum of all entries) cannot blow
    // catchUpBudgetBytes when many oversized files exist. We pack each item into a
    // TimestampedEntry keyed by file mtime so older (less-recently-modified) candidates are
    // dropped first; recently-touched files are likelier to need condensation feedback.
    const condensationTimestamped: TimestampedEntry[] = condensationItems.map((item, i) => {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(item.path).mtimeMs;
      } catch {
        // If stat fails the file has likely been removed mid-flight; treat it as oldest.
      }
      return {
        id: `knowledge_condensation:${item.label}:${i}`,
        // Pad mtime so timestamps sort lexicographically the same as numerically.
        timestamp: mtimeMs.toString().padStart(20, '0'),
        rendered: item.rendered,
        agentLabel: 'knowledge_condensation',
      };
    });
    const condensationTruncation = truncateOldestToFit(condensationTimestamped, catchUpBudgetBytes);
    if (condensationTruncation.droppedCount > 0) {
      // Map kept ids back to original items so the warning can list dropped paths.
      const keptIds = new Set(condensationTruncation.kept.map((e) => e.id));
      const droppedLabels = condensationTimestamped
        .filter((e) => !keptIds.has(e.id))
        .map((e) => e.id.split(':')[1]);
      log.warn(
        `[Scheduler] Truncated ${condensationTruncation.droppedCount} oldest knowledge condensation entries ` +
          `from memory-update delivery to fit ${catchUpBudgetBytes.toLocaleString()}-byte budget. ` +
          `Dropped: ${droppedLabels.join(', ')}`
      );
    }

    if (condensationTruncation.kept.length > 0) {
      const renderedEntries = condensationTruncation.kept.map((e) => e.rendered);
      messageParts.push(
        `## Knowledge Files Requiring Condensation\n\nThe following files exceed the ${knowledgeBudgetChars.toLocaleString()} character budget and are being truncated in agent contexts. For each: condense its content to under ${(knowledgeBudgetChars - 2_000).toLocaleString()} characters and write it back to the same path with \`commit_message: "knowledge: condense <filename>"\`. Preserve all structure and frontmatter. Drop outdated, redundant, or low-value content; merge similar entries; tighten prose. The full current content is provided below — no need to read the files separately.\n\n${renderedEntries.join('\n\n')}`
      );
    }
  }

  const fixedHeader = `[Scheduled task: memory-update]

memory_file: ${memoryFile}
last_narrator_update_ts: ${lastTs ?? '(none)'}
new_run_ts: ${newRunTs}

IMPORTANT: Do not message the Guide when you are done. This is a background task — no response is expected.`;

  const message = `${fixedHeader}${summaryAnnotation}

${messageParts.join('\n\n')}`;

  await narratorHost.deliverMessage(message, {
    sender: 0,
    receiver: narratorId,
    timestamp: Date.now(),
  });

  // Server-side cursor advancement for memory.md (always advances regardless of truncation)
  writeFrontmatterField(memoryFile, 'last_narrator_update_ts', newRunTs);
  commitIfStateDir(memoryFile, 'cursor: memory.md');
}
