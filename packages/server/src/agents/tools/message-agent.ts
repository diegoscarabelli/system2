/**
 * Message Agent Tool
 *
 * Enables inter-agent communication. Sends a message to another agent
 * by database ID. The message is delivered via sendCustomMessage and
 * appears in the receiver agent's LLM context.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { DatabaseClient } from '../../db/client.js';
import type { AgentRegistry } from '../registry.js';

export function createMessageAgentTool(
  selfId: number,
  registry: AgentRegistry,
  db: DatabaseClient
) {
  const params = Type.Object({
    agent_id: Type.Number({
      description:
        'The database ID of the agent to send a message to. Use query_database to find agent IDs.',
    }),
    message: Type.String({
      description: 'The message content to send to the agent.',
    }),
    urgent: Type.Optional(
      Type.Boolean({
        description:
          'If true, interrupts the receiver mid-turn (steer delivery). If false (default), waits for the receiver to finish its current turn (followUp delivery).',
      })
    ),
  });

  const tool: AgentTool<typeof params> = {
    name: 'message_agent',
    label: 'Message Agent',
    description:
      "Send a message to another agent in the system. The message appears in the receiver's context and triggers processing. Use query_database to look up available agents by role.",
    parameters: params,
    execute: async (_toolCallId, args) => {
      const { agent_id, message, urgent } = args;

      // Cannot message self
      if (agent_id === selfId) {
        return {
          content: [{ type: 'text', text: 'Error: Cannot send a message to yourself.' }],
          details: { error: 'self_message' },
        };
      }

      // Verify receiver exists in database
      const receiverAgent = db.getAgent(agent_id);
      if (!receiverAgent) {
        return {
          content: [{ type: 'text', text: `Error: No agent found with ID ${agent_id}.` }],
          details: { error: 'agent_not_found' },
        };
      }

      // Verify receiver has an active AgentHost
      const receiverHost = registry.get(agent_id);
      if (!receiverHost) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: Agent ${agent_id} (${receiverAgent.role}) is not currently active. Status: ${receiverAgent.status}.`,
            },
          ],
          details: { error: 'agent_not_active' },
        };
      }

      // Build LLM-visible content with sender prefix
      const senderAgent = db.getAgent(selfId);
      const senderRole = senderAgent?.role ?? 'unknown';
      const content = `[Message from ${senderRole} agent (id=${selfId})]\n\n${message}`;

      const timestamp = Date.now();

      try {
        await receiverHost.deliverMessage(
          content,
          { sender: selfId, receiver: agent_id, timestamp },
          urgent
        );

        return {
          content: [
            {
              type: 'text',
              text: `Message delivered to ${receiverAgent.role} agent (id=${agent_id}).`,
            },
          ],
          details: { delivered: true, agent_id, timestamp },
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error delivering message: ${(error as Error).message}`,
            },
          ],
          details: { error: (error as Error).message },
        };
      }
    },
  };

  return tool;
}
