/**
 * Terminate Agent Tool
 *
 * Archives an active agent: aborts its session, unregisters it from the
 * AgentRegistry, and marks it "archived" in the database.
 *
 * Permission model:
 *   - Guide may terminate any non-singleton agent (any project).
 *   - Conductors may terminate agents within their own project only.
 *   - Singleton agents (guide, narrator) cannot be terminated.
 *   - An agent cannot terminate itself.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { type Static, Type } from '@sinclair/typebox';
import type { DatabaseClient } from '../../db/client.js';
import type { AgentRegistry } from '../registry.js';

export function createTerminateAgentTool(
  db: DatabaseClient,
  agentId: number,
  registry: AgentRegistry,
  onTerminate?: () => void
) {
  const terminateAgentParams = Type.Object({
    agent_id: Type.Number({
      description:
        'Database ID of the agent to terminate. The agent will be archived, its current session aborted, and it will be removed from the active registry.',
    }),
  });

  const tool: AgentTool<typeof terminateAgentParams> = {
    name: 'terminate_agent',
    label: 'Terminate Agent',
    description:
      'Archive an active agent: abort its session, unregister it, and set status to "archived". Use this when a spawned agent has completed its work and is no longer needed. Guide may terminate any non-singleton agent. Conductors may only terminate agents within their own project. Singleton agents (guide, narrator) cannot be terminated.',
    parameters: terminateAgentParams,
    execute: async (_toolCallId, rawParams, _signal, _onUpdate) => {
      // pi-agent-core 0.71 (typebox-1) types execute params loosely (each
      // schema field as possibly undefined). Required fields are validated
      // before execute is called, so narrow once via the schema's Static type.
      const params = rawParams as Static<typeof terminateAgentParams>;
      const caller = db.getAgent(agentId);
      if (!caller) {
        return {
          content: [{ type: 'text' as const, text: 'Error: Calling agent not found.' }],
          details: { error: 'caller_not_found' },
        };
      }

      const target = db.getAgent(params.agent_id);
      if (!target) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: Agent ${params.agent_id} not found.`,
            },
          ],
          details: { error: 'target_not_found' },
        };
      }

      // Singleton agents cannot be terminated
      if (target.role === 'guide' || target.role === 'narrator') {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: Cannot terminate singleton agent (role: ${target.role}). Singleton agents run for the lifetime of the server.`,
            },
          ],
          details: { error: 'singleton_agent' },
        };
      }

      // Self-termination not allowed
      if (params.agent_id === agentId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: An agent cannot terminate itself. The Conductor that spawned you should terminate you when your work is done.',
            },
          ],
          details: { error: 'self_terminate' },
        };
      }

      // Only Guide and Conductors may terminate agents
      if (caller.role !== 'guide' && caller.role !== 'conductor') {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: Only Guide and Conductor agents may terminate other agents. Your role is "${caller.role}".`,
            },
          ],
          details: { error: 'unauthorized_role' },
        };
      }

      // Conductors can only terminate agents within their own project
      if (caller.role === 'conductor') {
        if (target.project !== caller.project) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: Conductors can only terminate agents in their own project (project ${caller.project}). Target agent belongs to project ${target.project}.`,
              },
            ],
            details: { error: 'wrong_project' },
          };
        }
      }

      // Mark as archived in DB
      db.updateAgentStatus(params.agent_id, 'archived');

      // Abort session and unregister
      const targetHost = registry.get(params.agent_id);
      if (targetHost) {
        targetHost.abort();
        registry.unregister(params.agent_id);
      }

      if (onTerminate) {
        try {
          onTerminate();
        } catch {
          // Best-effort notification: termination has already completed.
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Agent ${params.agent_id} (role: ${target.role}, project: ${target.project}) has been terminated and archived.`,
          },
        ],
        details: { terminated: true, agentId: params.agent_id, role: target.role },
      };
    },
  };

  return tool;
}
