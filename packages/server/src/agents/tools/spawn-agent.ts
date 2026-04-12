/**
 * Spawn Agent Tool
 *
 * Allows Guide to spawn agents for a project, and Conductors to spawn
 * Workers, Conductors, or a Reviewer within their own project.
 *
 * The spawner callback is provided by the Server and handles AgentHost creation,
 * registration, and initial message delivery.
 */

import type { Agent } from '@dscarabelli/shared';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { DatabaseClient } from '../../db/client.js';

export type AgentSpawner = (
  role: Agent['role'],
  projectId: number,
  callerAgentId: number,
  initialMessage: string
) => Promise<number>; // returns new agent's database ID

export function createSpawnAgentTool(db: DatabaseClient, agentId: number, spawner: AgentSpawner) {
  const params = Type.Object({
    role: Type.Union(
      [Type.Literal('conductor'), Type.Literal('reviewer'), Type.Literal('worker')],
      {
        description:
          'Role for the new agent. "conductor" for a specialist sub-agent that orchestrates tasks. "reviewer" for a Reviewer that validates analytical work and checks statistical rigor. "worker" for a lightweight execution agent that receives task-specific instructions via initial_message (no orchestration tools, no project-level state changes).',
      }
    ),
    project_id: Type.Number({
      description:
        'Project ID to assign the new agent to. Must already exist in app.db. Conductors may only spawn agents for their own project.',
    }),
    initial_message: Type.String({
      description:
        'Context and instructions delivered to the new agent immediately on creation. Include: project ID, assigned task IDs, specialization (for conductors), and any background needed to start work.',
    }),
  });

  const tool: AgentTool<typeof params> = {
    name: 'spawn_agent',
    label: 'Spawn Agent',
    description:
      "Spawn a new agent for a project. Guide may spawn conductors, workers, or reviewers for any project. Conductors may spawn conductors, workers, or a reviewer within their own project only. Returns the new agent's database ID — store it to send follow-up messages via message_agent and to set as task assignee.",
    parameters: params,
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      try {
        const caller = db.getAgent(agentId);
        if (!caller) {
          return {
            content: [{ type: 'text' as const, text: 'Error: Calling agent not found.' }],
            details: { error: 'caller_not_found' },
          };
        }

        // Conductors can only spawn agents within their own project
        if (caller.role === 'conductor') {
          if (caller.project === null || caller.project !== params.project_id) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error: Conductors can only spawn agents within their own project (project ${caller.project}). Requested project: ${params.project_id}.`,
                },
              ],
              details: { error: 'wrong_project' },
            };
          }
        }

        // Only Guide and Conductors can spawn agents
        if (caller.role !== 'guide' && caller.role !== 'conductor') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: Only Guide and Conductor agents may spawn new agents. Your role is "${caller.role}".`,
              },
            ],
            details: { error: 'unauthorized_role' },
          };
        }

        // Verify project exists
        const project = db.getProject(params.project_id);
        if (!project) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: Project ${params.project_id} not found. Create it first with write_system2_db createProject.`,
              },
            ],
            details: { error: 'project_not_found' },
          };
        }

        const newAgentId = await spawner(
          params.role,
          params.project_id,
          agentId,
          params.initial_message
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: `Agent spawned. New agent ID: ${newAgentId}, role: ${params.role}, project: ${params.project_id}. The agent has received its initial message and is now active. Use message_agent to send follow-up messages to agent ID ${newAgentId}, and set assignee: ${newAgentId} on tasks in app.db.`,
            },
          ],
          details: { agentId: newAgentId, role: params.role, projectId: params.project_id },
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error spawning agent: ${(error as Error).message}`,
            },
          ],
          details: { error: (error as Error).message },
        };
      }
    },
  };

  return tool;
}
