/**
 * Trigger Project Story Tool
 *
 * Called by the Conductor during the close-project routine. The server creates
 * a story task for the Narrator, pre-computes all project data, and delivers
 * two messages to the Narrator via FIFO queue:
 *
 * 1. A final project-log update (same format as the scheduled project-log job)
 * 2. A project story data message with a full app.db snapshot and log.md content
 *
 * The Narrator processes Message 1 (appends a final log entry), then Message 2
 * (writes the project story using the provided data + the log entry it just wrote).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { DatabaseClient } from '../../db/client.js';
import {
  collectAgentActivity,
  collectProjectDbChanges,
  formatMarkdownTable,
  readFrontmatterField,
  readTailChars,
} from '../../scheduler/jobs.js';
import type { AgentRegistry } from '../registry.js';

const SYSTEM2_DIR = join(homedir(), '.system2');

type AgentRow = { id: number; role: string; project_name: string | null };

export function createTriggerProjectStoryTool(
  db: DatabaseClient,
  agentId: number,
  registry: AgentRegistry
) {
  const params = Type.Object({
    project_id: Type.Number({
      description:
        'The project ID to trigger the story for. Must be a project you are assigned to.',
    }),
  });

  const tool: AgentTool<typeof params> = {
    name: 'trigger_project_story',
    label: 'Trigger Project Story',
    description:
      'Signal project completion and trigger the project story workflow. The server creates a story task for the Narrator, collects all project data, and delivers two messages: a final project-log update and a project story data package. Returns the story task ID. Call this during the close-project routine after all tasks are resolved.',
    parameters: params,
    execute: async (_toolCallId, params) => {
      try {
        // Validate caller
        const caller = db.getAgent(agentId);
        if (!caller) {
          return {
            content: [{ type: 'text' as const, text: 'Error: Calling agent not found.' }],
            details: { error: 'caller_not_found' },
          };
        }

        // Validate project
        const project = db.getProject(params.project_id);
        if (!project) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: Project ${params.project_id} not found.`,
              },
            ],
            details: { error: 'project_not_found' },
          };
        }

        // Conductors can only trigger for their own project
        if (caller.role === 'conductor' && caller.project !== params.project_id) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: You can only trigger project story for your own project (${caller.project}). Requested: ${params.project_id}.`,
              },
            ],
            details: { error: 'wrong_project' },
          };
        }

        // Find the Narrator
        const narrators = db.query(
          "SELECT id FROM agent WHERE role = 'narrator' AND status = 'active'"
        ) as Array<{ id: number }>;
        if (narrators.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'Error: No active Narrator agent found.' }],
            details: { error: 'narrator_not_found' },
          };
        }
        const narratorId = narrators[0].id;

        const narratorHost = registry.get(narratorId);
        if (!narratorHost) {
          return {
            content: [{ type: 'text' as const, text: 'Error: Narrator agent is not registered.' }],
            details: { error: 'narrator_not_registered' },
          };
        }

        // Compute project slug and paths
        const projectSlug = `${project.id}_${project.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')}`;
        const projectDir = join(SYSTEM2_DIR, 'projects', projectSlug);
        const logFile = join(projectDir, 'log.md');

        // Read timestamps
        const newRunTs = new Date().toISOString();
        const lastRunTs = readFrontmatterField(logFile, 'last_narrator_update_ts') ?? newRunTs;

        // Collect agent activity: project-scoped + Guide (not Narrator)
        const allAgents = db.query(
          "SELECT a.id, a.role, p.name as project_name FROM agent a LEFT JOIN project p ON a.project = p.id WHERE a.status != 'archived'"
        ) as AgentRow[];

        const projectScopedAgents = allAgents.filter(
          (a) => a.project_name === project.name
        ) as AgentRow[];
        const guideAgents = allAgents.filter(
          (a) => a.project_name === null && a.role === 'guide'
        ) as AgentRow[];
        const projectLogAgents = [...projectScopedAgents, ...guideAgents];

        const agentActivity = collectAgentActivity(
          SYSTEM2_DIR,
          projectLogAgents,
          lastRunTs,
          newRunTs
        );
        const projectDbChanges = collectProjectDbChanges(db, project.id, lastRunTs, newRunTs);

        // Read log.md content (full file, for Message 2)
        const logContent = existsSync(logFile) ? readFileSync(logFile, 'utf-8') : '(no log file)';

        // Read most recent log.md content (last 10,000 chars, for Message 1)
        const logContext = readTailChars(logFile, 10_000) || '(none)';

        // Create story task in app.db
        const storyTask = db.createTask({
          parent: null,
          project: project.id,
          title: 'Write project story',
          description: `Reconstruct project "${project.name}" journalistically using the provided data.`,
          status: 'todo',
          priority: 'medium',
          assignee: narratorId,
          labels: ['narrative'],
          start_at: null,
          end_at: null,
        });

        // --- Message 1: Final project-log update ---
        const projectLogMessage = `[Scheduled task: project-log]

project_id: ${project.id}
project_name: ${project.name}
file: ${logFile}
last_run_ts: ${lastRunTs}
new_run_ts: ${newRunTs}

## Most recent log.md content

${logContext}

## Agent Activity

${agentActivity}
## Database Changes

${projectDbChanges}`;

        narratorHost.deliverMessage(projectLogMessage, {
          sender: agentId,
          receiver: narratorId,
          timestamp: Date.now(),
        });

        // --- Message 2: Project story data ---
        // Full app.db snapshot (not time-windowed)
        const projectRecord = db.query(`SELECT * FROM project WHERE id = ${project.id}`) as Record<
          string,
          unknown
        >[];
        const agents = db.query(
          `SELECT * FROM agent WHERE project = ${project.id} OR (role IN ('guide', 'narrator') AND status != 'archived')`
        ) as Record<string, unknown>[];
        const tasks = db.query(
          `SELECT * FROM task WHERE project = ${project.id} ORDER BY created_at ASC`
        ) as Record<string, unknown>[];
        const taskIds = tasks.map((t) => t.id as number);
        const taskLinks =
          taskIds.length > 0
            ? (db.query(
                `SELECT * FROM task_link WHERE source IN (${taskIds.join(',')}) OR target IN (${taskIds.join(',')}) ORDER BY created_at ASC`
              ) as Record<string, unknown>[])
            : [];
        const taskComments =
          taskIds.length > 0
            ? (db.query(
                `SELECT * FROM task_comment WHERE task IN (${taskIds.join(',')}) ORDER BY created_at ASC`
              ) as Record<string, unknown>[])
            : [];

        // Check for an existing project story (from a previous completion cycle)
        const storyFile = join(projectDir, 'project_story.md');
        const existingStoryNote = existsSync(storyFile)
          ? `\n\n## Existing Project Story\n\nA previous project story exists at ${storyFile}. Read it and decide whether to edit or rewrite it to incorporate this new phase of work.`
          : '';

        const projectStoryMessage = `[Task: project-story]

project_id: ${project.id}
project_name: ${project.name}
task_id: ${storyTask.id}
conductor_id: ${agentId}${existingStoryNote}

## Project Record

${formatMarkdownTable(projectRecord)}

## Agents

${formatMarkdownTable(agents)}

## Tasks

${formatMarkdownTable(tasks)}

## Task Links

${taskLinks.length > 0 ? formatMarkdownTable(taskLinks) : '(none)'}

## Task Comments

${taskComments.length > 0 ? formatMarkdownTable(taskComments) : '(none)'}

## Project Log

Note: This log was captured before your preceding log update. Incorporate what you just wrote in the previous turn.

${logContent}`;

        narratorHost.deliverMessage(projectStoryMessage, {
          sender: agentId,
          receiver: narratorId,
          timestamp: Date.now(),
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `Project story triggered for project #${project.id} ("${project.name}"). Story task ID: ${storyTask.id}, assigned to Narrator (agent #${narratorId}). Two messages delivered to Narrator: a final project-log update and the project story data. The Narrator will message you when the story is written.`,
            },
          ],
          details: { task_id: storyTask.id, narrator_id: narratorId },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error triggering project story: ${message}` }],
          details: { error: message },
        };
      }
    },
  };

  return tool;
}
