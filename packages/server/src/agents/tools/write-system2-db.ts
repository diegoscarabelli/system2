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

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { DatabaseClient } from '../../db/client.js';

const PROJECT_STATUSES = ['todo', 'in progress', 'review', 'done', 'abandoned'] as const;
const TASK_PRIORITIES = ['low', 'medium', 'high'] as const;
const TASK_LINK_RELATIONSHIPS = ['blocked_by', 'relates_to', 'duplicates'] as const;

type ProjectStatus = (typeof PROJECT_STATUSES)[number];
type TaskPriority = (typeof TASK_PRIORITIES)[number];
type TaskLinkRelationship = (typeof TASK_LINK_RELATIONSHIPS)[number];

export function createWriteSystem2DbTool(db: DatabaseClient, agentId: number) {
  const params = Type.Object({
    operation: Type.Union(
      [
        Type.Literal('createProject'),
        Type.Literal('updateProject'),
        Type.Literal('createTask'),
        Type.Literal('updateTask'),
        Type.Literal('createTaskLink'),
        Type.Literal('deleteTaskLink'),
        Type.Literal('createTaskComment'),
        Type.Literal('deleteTaskComment'),
      ],
      {
        description:
          'Operation to perform. createProject/updateProject manage projects. createTask/updateTask manage tasks. createTaskLink/deleteTaskLink manage task relationships. createTaskComment/deleteTaskComment manage task comments.',
      }
    ),
    // Shared: ID for updates/deletes
    id: Type.Optional(
      Type.Number({
        description:
          'Record ID — required for updateProject, updateTask, deleteTaskLink, deleteTaskComment.',
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
      Type.String({ description: 'Comment content — required for createTaskComment.' })
    ),
  });

  const tool: AgentTool<typeof params> = {
    name: 'write_system2_db',
    label: 'Write System2 DB',
    description:
      'Create or update records in the System2 app database (~/.system2/app.db). Use named operations to manage projects, tasks, task links, and task comments. updated_at is maintained automatically. The author field on task comments is filled automatically from your agent ID. This tool is only for the System2 management database — not for data pipeline databases (use bash for those). For ad-hoc or complex SQL not covered by these operations, you can also use bash with sqlite3 ~/.system2/app.db.',
    parameters: params,
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      const err = (msg: string) => ({
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        details: { error: msg },
      });

      const ok = (result: unknown) => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        details: { result },
      });

      try {
        switch (params.operation) {
          case 'createProject': {
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
            return ok(result);
          }

          case 'updateProject': {
            if (params.id === undefined) return err('updateProject requires: id');
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
            return ok(result);
          }

          case 'createTask': {
            if (params.project === undefined) return err('createTask requires: project');
            if (!params.title) return err('createTask requires: title');
            if (!params.description) return err('createTask requires: description');
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
            return ok(result);
          }

          case 'updateTask': {
            if (params.id === undefined) return err('updateTask requires: id');
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
            return ok(result);
          }

          case 'createTaskLink': {
            if (params.source === undefined) return err('createTaskLink requires: source');
            if (params.target === undefined) return err('createTaskLink requires: target');
            if (!params.relationship) return err('createTaskLink requires: relationship');
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
            return ok(result);
          }

          case 'deleteTaskLink': {
            if (params.id === undefined) return err('deleteTaskLink requires: id');
            const deleted = db.deleteTaskLink(params.id);
            if (!deleted) return err(`No task link found with id ${params.id}`);
            return ok({ deleted: true, id: params.id });
          }

          case 'createTaskComment': {
            if (params.task === undefined) return err('createTaskComment requires: task');
            if (!params.content) return err('createTaskComment requires: content');
            const result = db.createTaskComment({
              task: params.task,
              author: agentId,
              content: params.content,
            });
            return ok(result);
          }

          case 'deleteTaskComment': {
            if (params.id === undefined) return err('deleteTaskComment requires: id');
            const deleted = db.deleteTaskComment(params.id);
            if (!deleted) return err(`No task comment found with id ${params.id}`);
            return ok({ deleted: true, id: params.id });
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
