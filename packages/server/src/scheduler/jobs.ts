/**
 * Scheduled Job Definitions
 *
 * Registers cron jobs for the Narrator agent. Jobs pre-compute all deterministic
 * data (timestamps, file paths, JSONL records, DB changes) so the Narrator
 * receives a ready-to-use message and can focus on narrative synthesis.
 *
 * sender: 0 is a sentinel for system-generated messages (no agent sender).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentHost } from '../agents/host.js';
import type { DatabaseClient } from '../db/client.js';
import type { Scheduler } from './scheduler.js';

/** Entry types to include from JSONL session files */
const INCLUDED_ENTRY_TYPES = new Set(['message', 'custom_message']);

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
 * Read the last N lines of a file.
 */
export function readTailLines(filePath: string, n: number): string {
  if (!existsSync(filePath)) return '';
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  return lines.slice(-n).join('\n');
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
 */
export function collectAgentActivity(
  system2Dir: string,
  agents: Array<{ id: number; role: string; project_name: string | null }>,
  lastRunTs: string,
  newRunTs: string
): string {
  const sections: string[] = [];

  for (const agent of agents) {
    const sessionDir = join(system2Dir, 'sessions', `${agent.role}_${agent.id}`);
    const label = agent.project_name
      ? `${agent.role}_${agent.id} (project: ${agent.project_name})`
      : `${agent.role}_${agent.id} (system-wide)`;

    if (!existsSync(sessionDir)) {
      sections.push(`### ${label}\n\n(no activity)\n`);
      continue;
    }

    const entries = readSessionEntries(sessionDir, lastRunTs, newRunTs);
    if (entries.length === 0) {
      sections.push(`### ${label}\n\n(no activity)\n`);
    } else {
      sections.push(`### ${label}\n\n${entries.join('\n')}\n`);
    }
  }

  return sections.join('\n');
}

/**
 * Read JSONL entries from all session files in a directory, filtered by time window.
 */
function readSessionEntries(sessionDir: string, lastRunTs: string, newRunTs: string): string[] {
  const files = readdirSync(sessionDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();

  const entries: string[] = [];

  for (const file of files) {
    const filePath = join(sessionDir, file);
    const content = readFileSync(filePath, 'utf-8');

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!INCLUDED_ENTRY_TYPES.has(entry.type)) continue;
        if (!entry.timestamp) continue;

        const ts = entry.timestamp;
        if (ts >= lastRunTs && ts < newRunTs) {
          entries.push(line);
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  return entries;
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

/**
 * Build and deliver a daily-summary message to the Narrator.
 * Shared by both the cron handler and server catch-up.
 */
export function buildAndDeliverDailySummary(
  db: DatabaseClient,
  narratorHost: AgentHost,
  narratorId: number,
  system2Dir: string,
  intervalMinutes: number
): void {
  const newRunTs = new Date().toISOString();
  const today = newRunTs.slice(0, 10);
  const summariesDir = join(system2Dir, 'knowledge', 'daily_summaries');
  const filePath = join(summariesDir, `${today}.md`);

  // Ensure directory exists
  if (!existsSync(summariesDir)) {
    mkdirSync(summariesDir, { recursive: true });
  }

  // 1. Read previous context (last 20 lines of most recent summary)
  let previousContext = '(none)';
  const existingFiles = readdirSync(summariesDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse();
  if (existingFiles.length > 0) {
    const tail = readTailLines(join(summariesDir, existingFiles[0]), 20);
    if (tail.trim()) previousContext = tail;
  }

  // 2. Create today's file if needed
  if (!existsSync(filePath)) {
    writeFileSync(
      filePath,
      `---\nlast_narrator_update_ts:\n---\n# Daily Summary — ${today}\n`,
      'utf-8'
    );
  }

  // 3. Resolve last_run_ts
  let lastRunTs = readFrontmatterField(filePath, 'last_narrator_update_ts');
  if (!lastRunTs) {
    lastRunTs = getMostRecentSummaryTimestamp(summariesDir);
  }
  if (!lastRunTs) {
    const memoryPath = join(system2Dir, 'knowledge', 'memory.md');
    lastRunTs = readFrontmatterField(memoryPath, 'last_narrator_update_ts');
  }
  if (!lastRunTs) {
    lastRunTs = new Date(Date.now() - intervalMinutes * 60_000).toISOString();
  }

  // 4. Gather agent activity
  const agents = db.query(
    "SELECT a.id, a.role, p.name as project_name FROM agent a LEFT JOIN project p ON a.project = p.id WHERE a.status != 'archived'"
  ) as Array<{ id: number; role: string; project_name: string | null }>;

  const agentActivity = collectAgentActivity(system2Dir, agents, lastRunTs, newRunTs);

  // 5. Gather database changes
  const dbChanges = collectDbChanges(db, lastRunTs, newRunTs);

  // 6. Check if there's any activity
  const hasAgentActivity = !agentActivity
    .split('\n')
    .every((line) => !line.trim() || line.startsWith('###') || line === '(no activity)');
  const hasDbChanges = dbChanges.includes('|');
  const hasPreviousContext = previousContext !== '(none)';

  if (!hasAgentActivity && !hasDbChanges && !hasPreviousContext) {
    console.log('[Scheduler] No activity since last run, skipping daily-summary');
    return;
  }

  // 7. Build and send message
  const message = `[Scheduled task: daily-summary]

file: ${filePath}
last_run_ts: ${lastRunTs}
new_run_ts: ${newRunTs}

## Previous Context

${previousContext}

## Agent Activity

${agentActivity}
## Database Changes

${dbChanges}`;

  narratorHost.deliverMessage(message, {
    sender: 0,
    receiver: narratorId,
    timestamp: Date.now(),
  });
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
  intervalMinutes: number
): void {
  // Daily summary — configurable interval
  const cronPattern = 60 % intervalMinutes === 0 ? `*/${intervalMinutes} * * * *` : '*/30 * * * *';

  scheduler.schedule('daily-summary', cronPattern, () => {
    console.log('[Scheduler] Triggering daily-summary job');
    buildAndDeliverDailySummary(db, narratorHost, narratorId, system2Dir, intervalMinutes);
  });

  // Memory update — daily at 4 AM
  scheduler.schedule('memory-update', '0 4 * * *', () => {
    console.log('[Scheduler] Triggering memory-update job');

    const newRunTs = new Date().toISOString();
    const memoryFile = join(system2Dir, 'knowledge', 'memory.md');
    const summariesDir = join(system2Dir, 'knowledge', 'daily_summaries');

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

    if (summaryFiles.length === 0) {
      console.log('[Scheduler] No daily summaries to incorporate, skipping memory-update');
      return;
    }

    const message = `[Scheduled task: memory-update]

memory_file: ${memoryFile}
last_narrator_update_ts: ${lastTs ?? '(none)'}
new_run_ts: ${newRunTs}

Daily summaries to incorporate:
${summaryFiles.map((f) => `- ${f}`).join('\n')}`;

    narratorHost.deliverMessage(message, {
      sender: 0,
      receiver: narratorId,
      timestamp: Date.now(),
    });
  });
}
