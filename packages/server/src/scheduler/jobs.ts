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
import { basename, join } from 'node:path';
import type { JobExecution } from '@dscarabelli/shared';
import type { AgentHost } from '../agents/host.js';
import type { DatabaseClient } from '../db/client.js';
import { resolveProjectDir } from '../projects/dir.js';
import { isNetworkAvailable } from './network.js';
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
 * Strip verbose fields from a parsed JSONL session entry before injecting into
 * the Narrator's context. Removes fields that are useless for narrative synthesis
 * (textSignature/thoughtSignature crypto signatures, token usage, provider metadata,
 * raw tool outputs) and truncates large argument/result values to 100 chars.
 *
 * Operates on plain objects — never mutates the input.
 */
export function stripSessionEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const type = entry.type;

  if (type === 'custom_message') {
    const { details: _d, ...rest } = entry;
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
          entries.push(JSON.stringify(stripSessionEntry(entry)));
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

/** Data collected for a single active project, reused across project log and daily summary */
interface ProjectActivityData {
  projectId: number;
  projectName: string;
  logFile: string;
  agentActivity: string;
  dbChanges: string;
  hasChanges: boolean;
}

type AgentRow = { id: number; role: string; project_name: string | null };

/**
 * Collect database changes scoped to a specific project.
 */
export function collectProjectDbChanges(
  db: DatabaseClient,
  projectId: number,
  lastRunTs: string,
  newRunTs: string
): string {
  const queries = [
    {
      name: 'project',
      sql: `SELECT * FROM project WHERE id = ${projectId} AND updated_at >= '${lastRunTs}' AND updated_at < '${newRunTs}'`,
    },
    {
      name: 'task',
      sql: `SELECT * FROM task WHERE project = ${projectId} AND updated_at >= '${lastRunTs}' AND updated_at < '${newRunTs}' ORDER BY updated_at ASC`,
    },
    {
      name: 'task_comment',
      sql: `SELECT tc.* FROM task_comment tc JOIN task t ON tc.task = t.id WHERE t.project = ${projectId} AND tc.created_at >= '${lastRunTs}' AND tc.created_at < '${newRunTs}' ORDER BY tc.created_at ASC`,
    },
    {
      name: 'task_link',
      sql: `SELECT tl.* FROM task_link tl JOIN task t ON tl.source = t.id WHERE t.project = ${projectId} AND tl.created_at >= '${lastRunTs}' AND tl.created_at < '${newRunTs}' ORDER BY tl.created_at ASC`,
    },
  ];

  const sections: string[] = [];
  for (const { name, sql } of queries) {
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
 * Collect database changes NOT belonging to any of the given project IDs.
 * Captures standalone tasks and changes to inactive/completed projects.
 */
export function collectNonProjectDbChanges(
  db: DatabaseClient,
  activeProjectIds: number[],
  lastRunTs: string,
  newRunTs: string
): string {
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

  const queries = [
    {
      name: 'project',
      sql: `SELECT * FROM project WHERE updated_at >= '${lastRunTs}' AND updated_at < '${newRunTs}' ${projectExcl} ORDER BY updated_at ASC`,
    },
    {
      name: 'task',
      sql: `SELECT * FROM task WHERE updated_at >= '${lastRunTs}' AND updated_at < '${newRunTs}' ${taskExcl} ORDER BY updated_at ASC`,
    },
    {
      name: 'task_comment',
      sql: `SELECT tc.* FROM task_comment tc JOIN task t ON tc.task = t.id WHERE tc.created_at >= '${lastRunTs}' AND tc.created_at < '${newRunTs}' ${joinTaskExcl} ORDER BY tc.created_at ASC`,
    },
    {
      name: 'task_link',
      sql: `SELECT tl.* FROM task_link tl JOIN task t ON tl.source = t.id WHERE tl.created_at >= '${lastRunTs}' AND tl.created_at < '${newRunTs}' ${joinTaskExcl} ORDER BY tl.created_at ASC`,
    },
  ];

  const sections: string[] = [];
  for (const { name, sql } of queries) {
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
 * Check if collected activity data contains any meaningful content.
 */
function hasActivity(agentActivity: string, dbChanges: string): boolean {
  const hasAgentLines = !agentActivity
    .split('\n')
    .every((line) => !line.trim() || line.startsWith('###') || line === '(no activity)');
  return hasAgentLines || dbChanges.includes('|');
}

/**
 * Advance last_narrator_update_ts in the daily summary file and all project log files.
 */
function advanceFrontmatterCursors(
  dailySummaryPath: string,
  projectDataList: ProjectActivityData[],
  newRunTs: string
): void {
  writeFrontmatterField(dailySummaryPath, 'last_narrator_update_ts', newRunTs);
  for (const pd of projectDataList) {
    if (pd.logFile) {
      writeFrontmatterField(pd.logFile, 'last_narrator_update_ts', newRunTs);
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
  intervalMinutes: number
): Promise<void> {
  const newRunTs = new Date().toISOString();
  const today = newRunTs.slice(0, 10);
  const summariesDir = join(system2Dir, 'knowledge', 'daily_summaries');
  const filePath = join(summariesDir, `${today}.md`);

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

  // 2. Read full content of today's daily summary file
  let dailySummaryContent = '(none)';
  const content = readFileSync(filePath, 'utf-8');
  if (content.trim()) dailySummaryContent = content;

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
    `SELECT DISTINCT p.id, p.name FROM project p
     JOIN agent a ON a.project = p.id
     WHERE a.role = 'conductor' AND a.status != 'archived'`
  ) as Array<{ id: number; name: string }>;

  const projectDataList: ProjectActivityData[] = [];
  const deliveries: Promise<void>[] = [];

  for (const project of activeProjects) {
    const projectDir = resolveProjectDir(join(system2Dir, 'projects'), project.id, project.name);
    const logFile = join(projectDir, 'log.md');

    // Create log file if needed
    if (!existsSync(logFile)) {
      writeFileSync(
        logFile,
        `---\nlast_narrator_update_ts:\nproject_id: ${project.id}\nproject_name: ${project.name}\n---\n`,
        'utf-8'
      );
    }

    // Read most recent log.md content (last 10,000 characters)
    let projectLogContext = '(none)';
    const logTail = readTailChars(logFile, 10_000);
    if (logTail.trim()) projectLogContext = logTail;

    // Project-scoped agents (Conductor, Reviewer, specialists)
    const projectScopedAgents = allAgents.filter(
      (a) => a.project_name === project.name
    ) as AgentRow[];

    // All agents involved: project-scoped + Guide (for project log)
    const allProjectAgents = [...projectScopedAgents, ...projectLogSystemAgents];

    const allProjectAgentActivity = collectAgentActivity(
      system2Dir,
      allProjectAgents,
      lastRunTs,
      newRunTs
    );
    const projectDbChanges = collectProjectDbChanges(db, project.id, lastRunTs, newRunTs);

    // Cache project-scoped agent activity for daily summary reuse
    const projectScopedActivity = collectAgentActivity(
      system2Dir,
      projectScopedAgents,
      lastRunTs,
      newRunTs
    );
    projectDataList.push({
      projectId: project.id,
      projectName: project.name,
      logFile,
      agentActivity: projectScopedActivity,
      dbChanges: projectDbChanges,
      hasChanges: hasActivity(projectScopedActivity, projectDbChanges),
    });

    // Deliver project-log message (with all agents including Guide)
    if (!hasActivity(allProjectAgentActivity, projectDbChanges)) continue;

    const projectLogMessage = `[Scheduled task: project-log]

project_id: ${project.id}
project_name: ${project.name}
file: ${logFile}
last_run_ts: ${lastRunTs}
new_run_ts: ${newRunTs}

IMPORTANT: Do not message the Guide when you are done. This is a background task — no response is expected.

## Most recent log.md content

${projectLogContext}

## Agent Activity

${allProjectAgentActivity}
## Database Changes

${projectDbChanges}`;

    deliveries.push(
      narratorHost.deliverMessage(projectLogMessage, {
        sender: 0,
        receiver: narratorId,
        timestamp: Date.now(),
      })
    );
  }

  // 6. Build daily summary — grouped by project vs non-project
  const activeProjectIds = projectDataList.map((p) => p.projectId);

  // Non-project: Guide + Narrator JSONL (full streams, span all projects)
  const nonProjectAgentActivity = collectAgentActivity(
    system2Dir,
    dailySummarySystemAgents,
    lastRunTs,
    newRunTs
  );
  const nonProjectDbChanges = collectNonProjectDbChanges(db, activeProjectIds, lastRunTs, newRunTs);

  // 7. Check for any activity at all
  const hasProjectChanges = projectDataList.some((pd) => pd.hasChanges);
  const hasNonProjectChanges = hasActivity(nonProjectAgentActivity, nonProjectDbChanges);

  if (!hasProjectChanges && !hasNonProjectChanges) {
    // Advance cursor even on skip to prevent re-scanning an empty window
    advanceFrontmatterCursors(filePath, projectDataList, newRunTs);
    throw new JobSkipped('no activity since last run');
  }

  // 8. Assemble daily summary message (only sections with activity)
  const messageParts: string[] = [
    `[Scheduled task: daily-summary]

file: ${filePath}
last_run_ts: ${lastRunTs}
new_run_ts: ${newRunTs}

IMPORTANT: Do not message the Guide when you are done. This is a background task — no response is expected.

## Current daily summary file content

${dailySummaryContent}`,
  ];

  const activeProjectParts: string[] = [];
  for (const pd of projectDataList) {
    if (!pd.hasChanges) continue;
    activeProjectParts.push(
      `### Project: ${pd.projectName} (#${pd.projectId})\n\n#### Agent Activity\n\n${pd.agentActivity}\n#### Database Changes\n\n${pd.dbChanges}`
    );
  }
  if (activeProjectParts.length > 0) {
    messageParts.push(`## Project Activity\n\n${activeProjectParts.join('\n')}`);
  }

  if (hasNonProjectChanges) {
    messageParts.push(
      `## Non-Project Activity\n\n#### Agent Activity\n\n${nonProjectAgentActivity}\n#### Database Changes\n\n${nonProjectDbChanges}`
    );
  }

  // 9. Deliver daily summary
  deliveries.push(
    narratorHost.deliverMessage(messageParts.join('\n\n'), {
      sender: 0,
      receiver: narratorId,
      timestamp: Date.now(),
    })
  );

  // Wait for the Narrator to finish processing all deliveries
  await Promise.all(deliveries);

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
 * Execute a job with execution tracking: inserts a 'running' record,
 * calls the handler, then marks it 'completed', 'skipped', or 'failed'.
 */
export async function trackJobExecution(
  db: DatabaseClient,
  jobName: string,
  triggerType: JobExecution['trigger_type'],
  handler: () => void | Promise<void>,
  onJobChange?: () => void
): Promise<void> {
  const execution = db.createJobExecution(jobName, triggerType);
  const notifyChange = () => {
    try {
      onJobChange?.();
    } catch {
      // Best-effort notification: job tracking must not break due to callback failure.
    }
  };
  notifyChange();
  try {
    await handler();
    db.completeJobExecution(execution.id);
    notifyChange();
  } catch (error) {
    if (error instanceof JobSkipped) {
      db.skipJobExecution(execution.id, error.reason);
      notifyChange();
      return;
    }
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    db.failJobExecution(execution.id, message);
    notifyChange();
    throw error;
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
  onJobChange?: () => void
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
        console.log('[Scheduler] Triggering daily-summary job (project logs + daily summary)');
        await buildAndDeliverDailySummary(
          db,
          narratorHost,
          narratorId,
          system2Dir,
          intervalMinutes
        );
      },
      onJobChange
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
        console.log('[Scheduler] Triggering memory-update job');
        await buildAndDeliverMemoryUpdate(
          narratorHost,
          narratorId,
          system2Dir,
          knowledgeBudgetChars
        );
      },
      onJobChange
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
  knowledgeBudgetChars = 20_000
): Promise<void> {
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

  if (summaryFiles.length > 0) {
    // Embed summary content inline so the Narrator doesn't need read tool calls
    const summaryEntries = summaryFiles.map((f) => {
      const content = readFileSync(f, 'utf-8');
      const filename = basename(f);
      return `### ${filename}\n\n${content}`;
    });
    messageParts.push(`## Daily summaries to incorporate\n\n${summaryEntries.join('\n\n')}`);
  }

  if (oversizedFiles.length > 0) {
    const condensationEntries = oversizedFiles.map(({ path: f, content }) => {
      const label = f.replace(system2Dir, '~/.system2');
      const overage = content.length - knowledgeBudgetChars;
      return `### ${label}\n\nCurrent size: ${content.length.toLocaleString()} chars (+${overage.toLocaleString()} over ${knowledgeBudgetChars.toLocaleString()} char budget)\n\n${content}`;
    });
    messageParts.push(
      `## Knowledge Files Requiring Condensation\n\nThe following files exceed the ${knowledgeBudgetChars.toLocaleString()} character budget and are being truncated in agent contexts. For each: condense its content to under ${(knowledgeBudgetChars - 2_000).toLocaleString()} characters and write it back to the same path with \`commit_message: "knowledge: condense <filename>"\`. Preserve all structure and frontmatter. Drop outdated, redundant, or low-value content; merge similar entries; tighten prose. The full current content is provided below — no need to read the files separately.\n\n${condensationEntries.join('\n\n')}`
    );
  }

  const message = `[Scheduled task: memory-update]

memory_file: ${memoryFile}
last_narrator_update_ts: ${lastTs ?? '(none)'}
new_run_ts: ${newRunTs}

IMPORTANT: Do not message the Guide when you are done. This is a background task — no response is expected.

${messageParts.join('\n\n')}`;

  await narratorHost.deliverMessage(message, {
    sender: 0,
    receiver: narratorId,
    timestamp: Date.now(),
  });

  // Server-side cursor advancement for memory.md
  writeFrontmatterField(memoryFile, 'last_narrator_update_ts', newRunTs);
}
