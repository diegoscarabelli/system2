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

/** Data collected for a single active project, reused across project log and daily summary */
interface ProjectActivityData {
  projectId: number;
  projectName: string;
  agentActivity: string;
  dbChanges: string;
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
 * Build and deliver project logs and daily summary to the Narrator.
 *
 * For each active project (conductor not archived), a project-log message is
 * delivered first with all involved agents' activity (project-scoped + Guide)
 * and project-scoped DB changes. The collected data is then reused
 * in the daily summary, which groups activity by project vs non-project.
 *
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
  // For daily summary non-project section: system-wide agents including Narrator
  const dailySummarySystemAgents = allAgents.filter((a) => a.project_name === null);

  // 5. Find active projects (conductor not archived) and deliver project logs
  const activeProjects = db.query(
    `SELECT DISTINCT p.id, p.name FROM project p
     JOIN agent a ON a.project = p.id
     WHERE a.role = 'conductor' AND a.status != 'archived'`
  ) as Array<{ id: number; name: string }>;

  const projectDataList: ProjectActivityData[] = [];

  for (const project of activeProjects) {
    const projectSlug = `${project.id}_${project.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')}`;
    const projectDir = join(system2Dir, 'projects', projectSlug);
    const logFile = join(projectDir, 'log.md');

    // Ensure project directory exists
    if (!existsSync(projectDir)) {
      mkdirSync(projectDir, { recursive: true });
    }

    // Create log file if needed
    if (!existsSync(logFile)) {
      writeFileSync(
        logFile,
        `---\nlast_narrator_update_ts:\nproject_id: ${project.id}\nproject_name: ${project.name}\n---\n# Project Log — ${project.name}\n`,
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
      agentActivity: projectScopedActivity,
      dbChanges: projectDbChanges,
    });

    // Deliver project-log message (with all agents including Guide)
    if (!hasActivity(allProjectAgentActivity, projectDbChanges)) continue;

    const projectLogMessage = `[Scheduled task: project-log]

project_id: ${project.id}
project_name: ${project.name}
file: ${logFile}
last_run_ts: ${lastRunTs}
new_run_ts: ${newRunTs}

IMPORTANT: After writing the log entry, you MUST set last_narrator_update_ts to exactly "${newRunTs}" (UTC ISO 8601) in the frontmatter of ${logFile}. This advances the cursor for the next run.

## Most recent log.md content

${projectLogContext}

## Agent Activity

${allProjectAgentActivity}
## Database Changes

${projectDbChanges}`;

    narratorHost.deliverMessage(projectLogMessage, {
      sender: 0,
      receiver: narratorId,
      timestamp: Date.now(),
    });
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

  // 7. Assemble daily summary message
  const messageParts: string[] = [
    `[Scheduled task: daily-summary]

file: ${filePath}
last_run_ts: ${lastRunTs}
new_run_ts: ${newRunTs}

IMPORTANT: After writing the summary, you MUST set last_narrator_update_ts to exactly "${newRunTs}" (UTC ISO 8601) in the frontmatter of ${filePath}. This advances the cursor for the next run.

## Current daily summary file content

${dailySummaryContent}`,
  ];

  if (projectDataList.length > 0) {
    const projectParts: string[] = [];
    for (const pd of projectDataList) {
      projectParts.push(
        `### Project: ${pd.projectName} (#${pd.projectId})\n\n#### Agent Activity\n\n${pd.agentActivity}\n#### Database Changes\n\n${pd.dbChanges}`
      );
    }
    messageParts.push(`## Project Activity\n\n${projectParts.join('\n')}`);
  }

  messageParts.push(
    `## Non-Project Activity\n\n#### Agent Activity\n\n${nonProjectAgentActivity}\n#### Database Changes\n\n${nonProjectDbChanges}`
  );

  // 8. Check for any activity at all
  const hasProjectChanges = projectDataList.some((pd) =>
    hasActivity(pd.agentActivity, pd.dbChanges)
  );
  const hasNonProjectChanges = hasActivity(nonProjectAgentActivity, nonProjectDbChanges);
  const hasDailySummaryContent = dailySummaryContent !== '(none)';

  if (!hasProjectChanges && !hasNonProjectChanges && !hasDailySummaryContent) {
    console.log('[Scheduler] No activity since last run, skipping daily-summary');
    return;
  }

  // 9. Deliver daily summary
  narratorHost.deliverMessage(messageParts.join('\n\n'), {
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
    console.log('[Scheduler] Triggering daily-summary job (project logs + daily summary)');
    buildAndDeliverDailySummary(db, narratorHost, narratorId, system2Dir, intervalMinutes);
  });

  // Memory update — daily at 11 AM
  scheduler.schedule('memory-update', '0 11 * * *', () => {
    console.log('[Scheduler] Triggering memory-update job');
    buildAndDeliverMemoryUpdate(narratorHost, narratorId, system2Dir);
  });
}

/**
 * Build and deliver a memory-update message to the Narrator.
 * Shared by both the cron handler and server catch-up.
 */
export function buildAndDeliverMemoryUpdate(
  narratorHost: AgentHost,
  narratorId: number,
  system2Dir: string
): void {
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

IMPORTANT: After writing memory.md, you MUST set last_narrator_update_ts to exactly "${newRunTs}" (UTC ISO 8601) in the frontmatter of ${memoryFile}. This advances the cursor for the next run.

Daily summaries to incorporate:
${summaryFiles.map((f) => `- ${f}`).join('\n')}`;

  narratorHost.deliverMessage(message, {
    sender: 0,
    receiver: narratorId,
    timestamp: Date.now(),
  });
}
