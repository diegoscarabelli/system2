/**
 * Resurrect Agent Tool
 *
 * Re-activates an archived agent: updates its status in the database,
 * re-initializes its AgentHost (resuming from its persisted JSONL session),
 * registers it in the AgentRegistry, and delivers a context message.
 *
 * Permission model:
 *   - Only the Guide may resurrect agents.
 *   - Singleton agents (guide, narrator) cannot be resurrected.
 *   - Already-active agents cannot be resurrected.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
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
  const params = Type.Object({
    agent_id: Type.Number({
      description:
        'Database ID of the archived agent to resurrect. The agent will be set back to active, its session resumed from its persisted JSONL history, and it will be re-registered in the agent registry.',
    }),
    message: Type.String({
      description:
        'Context message delivered to the resurrected agent. Must orient the agent about the time gap since termination, why it is being resurrected, and what work is now expected. Be specific: include project context, any changes since the agent was last active, and the new objectives.',
    }),
  });

  const tool: AgentTool<typeof params> = {
    name: 'resurrect_agent',
    label: 'Resurrect Agent',
    description:
      'Resurrect an archived agent: restore its session from persisted history, re-register it, and deliver a context message. ' +
      'IMPORTANT: Resurrection is a significant decision. Before using this tool, confirm with the user that resurrection (rather than starting a new project or carrying out a bespoke task) is the right approach. ' +
      'Help the user think through the tradeoffs: the resurrected agent retains its full conversation history and context, but that context may be stale. ' +
      'Only the Guide may resurrect agents. After resurrection, update the project record via write_system2_db: clear end_at and set status to "in progress".',
    parameters: params,
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      const caller = db.getAgent(agentId);
      if (!caller) {
        return {
          content: [{ type: 'text' as const, text: 'Error: Calling agent not found.' }],
          details: { error: 'caller_not_found' },
        };
      }

      // Only the Guide may resurrect agents
      if (caller.role !== 'guide') {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: Only the Guide may resurrect agents. Your role is "${caller.role}".`,
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
