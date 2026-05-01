/**
 * Resurrect Agent Tool
 *
 * Re-activates an archived agent: updates its status in the database,
 * re-initializes its AgentHost (resuming from its persisted JSONL session),
 * registers it in the AgentRegistry, and delivers a context message.
 *
 * Permission model:
 *   - Guide may resurrect any archived non-singleton agent.
 *   - Conductors may resurrect archived agents within their own project.
 *   - Singleton agents (guide, narrator) cannot be resurrected.
 *   - Already-active agents cannot be resurrected.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { type Static, Type } from '@sinclair/typebox';
import type { DatabaseClient } from '../../db/client.js';

export type AgentResurrector = (
  agentId: number,
  callerAgentId: number,
  message: string
) => Promise<void>;

export function createResurrectAgentTool(
  db: DatabaseClient,
  agentId: number,
  resurrector: AgentResurrector
) {
  const resurrectAgentParams = Type.Object({
    agent_id: Type.Number({
      description:
        'Database ID of the archived agent to resurrect. The agent will be set back to active, its session resumed from its persisted JSONL history, and it will be re-registered in the agent registry.',
    }),
    message: Type.String({
      description:
        'Context message delivered to the resurrected agent. Must orient the agent about the time gap since termination, why it is being resurrected, and what work is now expected. Be specific: include project context, any changes since the agent was last active, and the new objectives.',
    }),
  });

  const tool: AgentTool<typeof resurrectAgentParams> = {
    name: 'resurrect_agent',
    label: 'Resurrect Agent',
    description:
      'Resurrect an archived agent: restore its session from persisted history, re-register it, and deliver a context message. ' +
      'IMPORTANT: Resurrection is a significant decision. Before using this tool, confirm that resurrection (rather than starting a new project or carrying out a bespoke task) is the right approach. ' +
      'The resurrected agent retains its full conversation history and context, but that context may be stale. ' +
      'Guide may resurrect any archived non-singleton. Conductors may only resurrect agents within their own project. ' +
      'After resurrection, update the project record via write_system2_db: clear end_at and set status to "in progress".',
    parameters: resurrectAgentParams,
    execute: async (_toolCallId, rawParams, _signal, _onUpdate) => {
      // pi-agent-core 0.71 (typebox-1) types execute params loosely (each
      // schema field as possibly undefined). Required fields are validated
      // before execute is called, so narrow once via the schema's Static type.
      const params = rawParams as Static<typeof resurrectAgentParams>;
      const caller = db.getAgent(agentId);
      if (!caller) {
        return {
          content: [{ type: 'text' as const, text: 'Error: Calling agent not found.' }],
          details: { error: 'caller_not_found' },
        };
      }

      // Only Guide and Conductors may resurrect agents
      if (caller.role !== 'guide' && caller.role !== 'conductor') {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: Only Guide and Conductor agents may resurrect agents. Your role is "${caller.role}".`,
            },
          ],
          details: { error: 'unauthorized_role' },
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

      // Conductors can only resurrect agents within their own project
      if (caller.role === 'conductor') {
        if (target.project !== caller.project) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: Conductors can only resurrect agents in their own project (project ${caller.project}). Target agent belongs to project ${target.project}.`,
              },
            ],
            details: { error: 'wrong_project' },
          };
        }
      }

      // Singleton agents cannot be resurrected (they are never archived)
      if (target.role === 'guide' || target.role === 'narrator') {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: Cannot resurrect singleton agent (role: ${target.role}). Singleton agents run for the lifetime of the server.`,
            },
          ],
          details: { error: 'singleton_agent' },
        };
      }

      // Must be archived to resurrect
      if (target.status !== 'archived') {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: Agent ${params.agent_id} is already active. Only archived agents can be resurrected.`,
            },
          ],
          details: { error: 'already_active' },
        };
      }

      // Update DB status
      db.updateAgentStatus(params.agent_id, 'active');

      try {
        // Initialize AgentHost (resumes from JSONL) and deliver message
        await resurrector(params.agent_id, agentId, params.message);
      } catch (error) {
        // Roll back DB status on failure
        db.updateAgentStatus(params.agent_id, 'archived');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error resurrecting agent: ${(error as Error).message}`,
            },
          ],
          details: { error: (error as Error).message },
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Agent ${params.agent_id} (role: ${target.role}, project: ${target.project}) has been resurrected. ` +
              `Its session has been restored from persisted history and the context message delivered. ` +
              `Remember to update the project record via write_system2_db: clear end_at and set status to "in progress".`,
          },
        ],
        details: { resurrected: true, agentId: params.agent_id, role: target.role },
      };
    },
  };

  return tool;
}
