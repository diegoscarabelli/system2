/**
 * Write System2 DB Tool
 *
 * Allows agents to create and update records in System2's app.db.
 * Uses structured named operations that map to DatabaseClient methods,
 * ensuring updated_at is always maintained and task comment author is
 * auto-filled from the calling agent's ID.
 *
 * This is NOT for writing to data pipeline databases — use bash for those.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { type Static, Type } from '@sinclair/typebox';
import type { DatabaseClient } from '../../db/client.js';
import { resolveProjectDir } from '../../projects/dir.js';

const SYSTEM2_DIR = join(homedir(), '.system2');

const PROJECT_STATUSES = ['todo', 'in progress', 'review', 'done', 'abandoned'] as const;
const TASK_PRIORITIES = ['low', 'medium', 'high'] as const;
const TASK_LINK_RELATIONSHIPS = ['blocked_by', 'relates_to', 'duplicates'] as const;

type ProjectStatus = (typeof PROJECT_STATUSES)[number];
type TaskPriority = (typeof TASK_PRIORITIES)[number];
type TaskLinkRelationship = (typeof TASK_LINK_RELATIONSHIPS)[number];

/** Entity categories affected by a write operation. */
export type WriteEntityType =
  | 'project'
  | 'task'
  | 'task_link'
  | 'task_comment'
  | 'artifact'
  | 'unknown';

/** Callback fired after every successful write_system2_db operation. */
export type OnDatabaseWrite = (entityType: WriteEntityType) => void;

/** Blocked SQL patterns: DDL, PRAGMA, ATTACH/DETACH (strips leading SQL comments). */
const BLOCKED_SQL_PATTERNS =
  /^(?:\s|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)*(CREATE|ALTER|DROP|PRAGMA|ATTACH|DETACH)\b/i;

/** Strip leading SQL comments (line and block) to find the actual statement keyword. */
function stripLeadingSqlComments(sql: string): string {
  let remaining = sql;
  for (;;) {
    const trimmed = remaining.trimStart();
    if (trimmed.startsWith('--')) {
      const nl = trimmed.indexOf('\n');
      remaining = nl === -1 ? '' : trimmed.slice(nl + 1);
      continue;
    }
    if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      remaining = end === -1 ? '' : trimmed.slice(end + 2);
      continue;
    }
    return trimmed;
  }
}

const ALLOWED_RAW_SQL = /^(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE)\b/i;

function checkProjectScope(
  agentProject: number | null,
  recordProject: number | null
): string | null {
  if (agentProject === null) return null;
  if (recordProject === null) return null;
  if (recordProject !== agentProject) {
    return `Your agent is scoped to project ${agentProject}. The target record belongs to project ${recordProject}. You can only operate on records within your own project.`;
  }
  return null;
}

export function createWriteSystem2DbTool(
  db: DatabaseClient,
  agentId: number,
  onWrite?: OnDatabaseWrite
) {
  const writeSystem2DbParams = Type.Object({
    operation: Type.Union(
      [
        Type.Literal('createProject'),
        Type.Literal('updateProject'),
        Type.Literal('createTask'),
        Type.Literal('updateTask'),
        Type.Literal('claimTask'),
        Type.Literal('createTaskLink'),
        Type.Literal('deleteTaskLink'),
        Type.Literal('createTaskComment'),
        Type.Literal('updateTaskComment'),
        Type.Literal('deleteTaskComment'),
        Type.Literal('createArtifact'),
        Type.Literal('updateArtifact'),
        Type.Literal('deleteArtifact'),
        Type.Literal('rawSql'),
      ],
      {
        description:
          'Operation to perform. createProject (Guide only) / updateProject (Guide and Conductor, own project) manage projects. createTask / updateTask manage tasks (project-scoped; assignee field restricted to Guide and Conductor). claimTask atomically claims an unassigned todo task (pull model, secondary to assignment). createTaskLink / deleteTaskLink manage task relationships (project-scoped). createTaskComment / updateTaskComment / deleteTaskComment manage task comments (project-scoped; author auto-filled on create; updateTaskComment is restricted to the original author and only replaces the content). createArtifact / updateArtifact / deleteArtifact manage artifact metadata (file_path is absolute; deleteArtifact removes DB record only). rawSql executes arbitrary DML (INSERT/UPDATE/DELETE) or SELECT — DDL (CREATE/ALTER/DROP), PRAGMA, and ATTACH are blocked.',
      }
    ),
    // Shared: ID for updates/deletes
    id: Type.Optional(
      Type.Number({
        description:
          'Record ID — required for updateProject, updateTask, deleteTaskLink, updateTaskComment, deleteTaskComment, updateArtifact, deleteArtifact.',
      })
    ),
    // Project / Task shared fields
    name: Type.Optional(Type.String({ description: 'Project name.' })),
    description: Type.Optional(
      Type.String({
        description: 'Project or task description. Required for createProject and createTask.',
      })
    ),
    status: Type.Optional(
      Type.String({
        description: `Status value. Valid values: ${PROJECT_STATUSES.map((s) => `"${s}"`).join(', ')}.`,
      })
    ),
    labels: Type.Optional(
      Type.Array(Type.String(), { description: 'Array of string labels for categorization.' })
    ),
    start_at: Type.Optional(
      Type.String({ description: 'ISO 8601 timestamp for when work started.' })
    ),
    end_at: Type.Optional(
      Type.String({ description: 'ISO 8601 timestamp for when work completed.' })
    ),
    // Task-specific fields
    project: Type.Optional(Type.Number({ description: 'Project ID — required for createTask.' })),
    parent: Type.Optional(Type.Number({ description: 'Parent task ID for subtask hierarchy.' })),
    title: Type.Optional(Type.String({ description: 'Task title — required for createTask.' })),
    priority: Type.Optional(
      Type.String({
        description: `Task priority. Valid values: ${TASK_PRIORITIES.map((p) => `"${p}"`).join(', ')}.`,
      })
    ),
    assignee: Type.Optional(Type.Number({ description: 'Agent ID to assign the task to.' })),
    // Task link fields
    source: Type.Optional(
      Type.Number({ description: 'Source task ID — required for createTaskLink.' })
    ),
    target: Type.Optional(
      Type.Number({ description: 'Target task ID — required for createTaskLink.' })
    ),
    relationship: Type.Optional(
      Type.String({
        description: `Relationship type — required for createTaskLink. Valid values: ${TASK_LINK_RELATIONSHIPS.map((r) => `"${r}"`).join(', ')}.`,
      })
    ),
    // Task comment fields
    task: Type.Optional(Type.Number({ description: 'Task ID — required for createTaskComment.' })),
    content: Type.Optional(
      Type.String({
        description:
          'Comment content — required for createTaskComment and updateTaskComment. On update, replaces the entire comment body.',
      })
    ),
    // Artifact fields
    file_path: Type.Optional(
      Type.String({
        description: 'Absolute path to artifact file on disk — required for createArtifact.',
      })
    ),
    tags: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Array of string tags for artifact categorization.',
      })
    ),
    // rawSql field
    sql: Type.Optional(
      Type.String({
        description:
          'SQL statement — required for rawSql. DML (INSERT/UPDATE/DELETE) and SELECT only. DDL (CREATE/ALTER/DROP), PRAGMA, and ATTACH are blocked.',
      })
    ),
  });

  /** Notify after a successful write. */
  const notify = (entityType: WriteEntityType) => {
    try {
      onWrite?.(entityType);
    } catch {
      // Broadcast failures must not break the tool result
    }
  };

  const tool: AgentTool<typeof writeSystem2DbParams> = {
    name: 'write_system2_db',
    label: 'Write System2 DB',
    description:
      "Create or update records in the System2 app database (~/.system2/app.db). Use named operations to manage projects, tasks, task links, task comments, and artifacts. updated_at is maintained automatically. The author field on task comments is filled automatically from your agent ID. claimTask atomically claims a todo task — only use this when operating in pull mode at the Conductor's direction, not as a substitute for working your assigned tasks. createArtifact/updateArtifact/deleteArtifact manage artifact metadata (file_path must be absolute; deleteArtifact removes the DB record only, not the file). rawSql is a last-resort escape hatch for ad-hoc DML or SELECT queries not covered by the named operations. This tool is only for the System2 management database — not for data pipeline databases (use bash for those).",
    parameters: writeSystem2DbParams,
    execute: async (_toolCallId, rawParams, _signal, _onUpdate) => {
      // pi-agent-core 0.71 (typebox-1) types execute params loosely (each
      // schema field as possibly undefined). Required fields are validated
      // before execute is called, so narrow once via the schema's Static type.
      const params = rawParams as Static<typeof writeSystem2DbParams>;
      const err = (msg: string) => ({
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        details: { error: msg },
      });

      const ok = (result: unknown, entityType?: WriteEntityType) => {
        if (entityType) notify(entityType);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          details: { result },
        };
      };

      try {
        const self = db.getAgent(agentId);
        if (!self) return err('Calling agent not found in database.');

        const isGuideOrConductor = self.role === 'guide' || self.role === 'conductor';

        switch (params.operation) {
          case 'createProject': {
            if (self.role !== 'guide') {
              return err(
                'createProject is restricted to the Guide agent. Only Guide creates and owns projects; Conductors execute them.'
              );
            }
            if (!params.name) return err('createProject requires: name');
            if (!params.description) return err('createProject requires: description');
            if (params.status && !PROJECT_STATUSES.includes(params.status as ProjectStatus)) {
              return err(
                `Invalid status "${params.status}". Valid values: ${PROJECT_STATUSES.join(', ')}`
              );
            }
            const result = db.createProject({
              name: params.name,
              description: params.description,
              status: (params.status as ProjectStatus) ?? 'todo',
              labels: params.labels ?? [],
              start_at: params.start_at ?? null,
              end_at: params.end_at ?? null,
            });
            // Ensure the project directory exists on disk
            resolveProjectDir(join(SYSTEM2_DIR, 'projects'), result.id, result.name);
            return ok(result, 'project');
          }

          case 'updateProject': {
            if (params.id === undefined) return err('updateProject requires: id');
            if (!isGuideOrConductor) {
              return err(
                `updateProject is restricted to Guide and Conductor agents. Your role is "${self.role}".`
              );
            }
            if (self.role === 'conductor' && self.project !== params.id) {
              return err(
                `Conductors can only update their own project (project ${self.project}). Requested project: ${params.id}.`
              );
            }
            if (params.status && !PROJECT_STATUSES.includes(params.status as ProjectStatus)) {
              return err(
                `Invalid status "${params.status}". Valid values: ${PROJECT_STATUSES.join(', ')}`
              );
            }
            const result = db.updateProject(params.id, {
              ...(params.name !== undefined && { name: params.name }),
              ...(params.description !== undefined && { description: params.description }),
              ...(params.status !== undefined && { status: params.status as ProjectStatus }),
              ...(params.labels !== undefined && { labels: params.labels }),
              ...(params.start_at !== undefined && { start_at: params.start_at }),
              ...(params.end_at !== undefined && { end_at: params.end_at }),
            });
            if (!result) return err(`No project found with id ${params.id}`);
            // Rename directory on disk when the project name changes
            if (params.name !== undefined) {
              resolveProjectDir(join(SYSTEM2_DIR, 'projects'), result.id, result.name);
            }
            return ok(result, 'project');
          }

          case 'createTask': {
            if (params.project === undefined) return err('createTask requires: project');
            if (!params.title) return err('createTask requires: title');
            if (!params.description) return err('createTask requires: description');
            const createTaskScopeErr = checkProjectScope(self.project, params.project);
            if (createTaskScopeErr) return err(createTaskScopeErr);
            if (params.assignee !== undefined && !isGuideOrConductor) {
              return err('Only Guide and Conductor agents can set the assignee field.');
            }
            if (params.status && !PROJECT_STATUSES.includes(params.status as ProjectStatus)) {
              return err(
                `Invalid status "${params.status}". Valid values: ${PROJECT_STATUSES.join(', ')}`
              );
            }
            if (params.priority && !TASK_PRIORITIES.includes(params.priority as TaskPriority)) {
              return err(
                `Invalid priority "${params.priority}". Valid values: ${TASK_PRIORITIES.join(', ')}`
              );
            }
            const result = db.createTask({
              project: params.project,
              parent: params.parent ?? null,
              title: params.title,
              description: params.description,
              status: (params.status as ProjectStatus) ?? 'todo',
              priority: (params.priority as TaskPriority) ?? 'medium',
              assignee: params.assignee ?? null,
              labels: params.labels ?? [],
              start_at: params.start_at ?? null,
              end_at: params.end_at ?? null,
            });

            return ok(result, 'task');
          }

          case 'updateTask': {
            if (params.id === undefined) return err('updateTask requires: id');
            const updateTaskTarget = db.getTask(params.id);
            if (!updateTaskTarget) return err(`No task found with id ${params.id}`);
            const updateTaskScopeErr = checkProjectScope(self.project, updateTaskTarget.project);
            if (updateTaskScopeErr) return err(updateTaskScopeErr);
            if (params.assignee !== undefined && !isGuideOrConductor) {
              return err('Only Guide and Conductor agents can set the assignee field.');
            }
            if (params.status && !PROJECT_STATUSES.includes(params.status as ProjectStatus)) {
              return err(
                `Invalid status "${params.status}". Valid values: ${PROJECT_STATUSES.join(', ')}`
              );
            }
            if (params.priority && !TASK_PRIORITIES.includes(params.priority as TaskPriority)) {
              return err(
                `Invalid priority "${params.priority}". Valid values: ${TASK_PRIORITIES.join(', ')}`
              );
            }
            const result = db.updateTask(params.id, {
              ...(params.parent !== undefined && { parent: params.parent }),
              ...(params.title !== undefined && { title: params.title }),
              ...(params.description !== undefined && { description: params.description }),
              ...(params.status !== undefined && { status: params.status as ProjectStatus }),
              ...(params.priority !== undefined && { priority: params.priority as TaskPriority }),
              ...(params.assignee !== undefined && { assignee: params.assignee }),
              ...(params.labels !== undefined && { labels: params.labels }),
              ...(params.start_at !== undefined && { start_at: params.start_at }),
              ...(params.end_at !== undefined && { end_at: params.end_at }),
            });
            if (!result) return err(`No task found with id ${params.id}`);

            return ok(result, 'task');
          }

          case 'claimTask': {
            if (params.id === undefined) return err('claimTask requires: id');
            const result = db.claimTask(agentId, params.id);
            if (!result.claimed) {
              const reason =
                result.error === 'task_not_found'
                  ? `No task found with id ${params.id}.`
                  : result.error === 'wrong_project'
                    ? `Task ${params.id} belongs to a different project than your agent. claimTask only works within your own project.`
                    : `Task ${params.id} is no longer available (status is not 'todo').`;
              return {
                content: [{ type: 'text' as const, text: `Claim failed: ${reason}` }],
                details: { claimed: false, error: result.error },
              };
            }

            return ok({ claimed: true, task: result.task }, 'task');
          }

          case 'createTaskLink': {
            if (params.source === undefined) return err('createTaskLink requires: source');
            if (params.target === undefined) return err('createTaskLink requires: target');
            if (!params.relationship) return err('createTaskLink requires: relationship');
            const linkSourceTask = db.getTask(params.source);
            if (!linkSourceTask) return err(`Source task ${params.source} not found.`);
            const linkScopeErr = checkProjectScope(self.project, linkSourceTask.project);
            if (linkScopeErr) return err(linkScopeErr);
            if (!TASK_LINK_RELATIONSHIPS.includes(params.relationship as TaskLinkRelationship)) {
              return err(
                `Invalid relationship "${params.relationship}". Valid values: ${TASK_LINK_RELATIONSHIPS.join(', ')}`
              );
            }
            const result = db.createTaskLink({
              source: params.source,
              target: params.target,
              relationship: params.relationship as TaskLinkRelationship,
            });

            return ok(result, 'task_link');
          }

          case 'deleteTaskLink': {
            if (params.id === undefined) return err('deleteTaskLink requires: id');
            const link = db.getTaskLink(params.id);
            if (!link) return err(`No task link found with id ${params.id}`);
            const delLinkSource = db.getTask(link.source);
            if (delLinkSource) {
              const delLinkScopeErr = checkProjectScope(self.project, delLinkSource.project);
              if (delLinkScopeErr) return err(delLinkScopeErr);
            }
            const deleted = db.deleteTaskLink(params.id);
            if (!deleted) return err(`No task link found with id ${params.id}`);

            return ok({ deleted: true, id: params.id }, 'task_link');
          }

          case 'createTaskComment': {
            if (params.task === undefined) return err('createTaskComment requires: task');
            if (!params.content) return err('createTaskComment requires: content');
            const commentTask = db.getTask(params.task);
            if (!commentTask) return err(`Task ${params.task} not found.`);
            const commentScopeErr = checkProjectScope(self.project, commentTask.project);
            if (commentScopeErr) return err(commentScopeErr);
            const result = db.createTaskComment({
              task: params.task,
              author: agentId,
              content: params.content,
            });

            return ok(result, 'task_comment');
          }

          case 'updateTaskComment': {
            if (params.id === undefined) return err('updateTaskComment requires: id');
            if (!params.content) return err('updateTaskComment requires: content');
            const updateComment = db.getTaskComment(params.id);
            if (!updateComment) return err(`No task comment found with id ${params.id}`);
            const updateCommentTask = db.getTask(updateComment.task);
            if (updateCommentTask) {
              const updateCommentScopeErr = checkProjectScope(
                self.project,
                updateCommentTask.project
              );
              if (updateCommentScopeErr) return err(updateCommentScopeErr);
            }
            if (updateComment.author !== agentId) {
              return err(
                `Only the original author can update a task comment. Comment ${params.id} was authored by agent ${updateComment.author}; you are agent ${agentId}. Post a new comment instead.`
              );
            }
            const result = db.updateTaskComment(params.id, params.content);
            if (!result) return err(`No task comment found with id ${params.id}`);
            return ok(result);
          }

          case 'deleteTaskComment': {
            if (params.id === undefined) return err('deleteTaskComment requires: id');
            const comment = db.getTaskComment(params.id);
            if (!comment) return err(`No task comment found with id ${params.id}`);
            const delCommentTask = db.getTask(comment.task);
            if (delCommentTask) {
              const delCommentScopeErr = checkProjectScope(self.project, delCommentTask.project);
              if (delCommentScopeErr) return err(delCommentScopeErr);
            }
            const deleted = db.deleteTaskComment(params.id);
            if (!deleted) return err(`No task comment found with id ${params.id}`);
            return ok({ deleted: true, id: params.id }, 'task_comment');
          }

          case 'createArtifact': {
            if (!params.file_path) return err('createArtifact requires: file_path');
            if (!params.title) return err('createArtifact requires: title');
            if (params.project !== undefined) {
              const createArtifactScopeErr = checkProjectScope(self.project, params.project);
              if (createArtifactScopeErr) return err(createArtifactScopeErr);
            }
            const result = db.createArtifact({
              project: params.project ?? null,
              file_path: params.file_path,
              title: params.title,
              description: params.description ?? null,
              tags: params.tags ?? [],
            });

            return ok(result, 'artifact');
          }

          case 'updateArtifact': {
            if (params.id === undefined) return err('updateArtifact requires: id');
            const existingArtifact = db.getArtifact(params.id);
            if (!existingArtifact) return err(`No artifact found with id ${params.id}`);
            const updateArtifactScopeErr = checkProjectScope(
              self.project,
              existingArtifact.project
            );
            if (updateArtifactScopeErr) return err(updateArtifactScopeErr);
            const result = db.updateArtifact(params.id, {
              ...(params.project !== undefined && { project: params.project }),
              ...(params.file_path !== undefined && { file_path: params.file_path }),
              ...(params.title !== undefined && { title: params.title }),
              ...(params.description !== undefined && { description: params.description }),
              ...(params.tags !== undefined && { tags: params.tags }),
            });
            if (!result) return err(`No artifact found with id ${params.id}`);

            return ok(result, 'artifact');
          }

          case 'deleteArtifact': {
            if (params.id === undefined) return err('deleteArtifact requires: id');
            const deleteArtifactTarget = db.getArtifact(params.id);
            if (!deleteArtifactTarget) return err(`No artifact found with id ${params.id}`);
            const deleteArtifactScopeErr = checkProjectScope(
              self.project,
              deleteArtifactTarget.project
            );
            if (deleteArtifactScopeErr) return err(deleteArtifactScopeErr);
            const deleted = db.deleteArtifact(params.id);
            if (!deleted) return err(`No artifact found with id ${params.id}`);

            return ok({ deleted: true, id: params.id }, 'artifact');
          }

          case 'rawSql': {
            if (!params.sql) return err('rawSql requires: sql');
            if (BLOCKED_SQL_PATTERNS.test(params.sql)) {
              return err(
                'rawSql blocks DDL (CREATE/ALTER/DROP), PRAGMA, and ATTACH/DETACH statements. Only DML (INSERT/UPDATE/DELETE) and SELECT are allowed.'
              );
            }
            const stripped = stripLeadingSqlComments(params.sql);
            if (!ALLOWED_RAW_SQL.test(stripped)) {
              return err(
                'rawSql only allows SELECT, INSERT, UPDATE, DELETE, WITH, and REPLACE statements.'
              );
            }
            const result = db.runSql(params.sql);
            // Only fire onWrite for statements that modified data
            if (result.changes > 0) {
              return ok(result, 'unknown');
            }
            return {
              content: [{ type: 'text', text: JSON.stringify(result) }],
              details: { result },
            };
          }

          default:
            return err(`Unknown operation: ${params.operation}`);
        }
      } catch (error) {
        return err((error as Error).message);
      }
    },
  };

  return tool;
}
