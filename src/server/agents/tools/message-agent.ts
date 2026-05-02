/**
 * Message Agent Tool
 *
 * Enables inter-agent communication. Sends a message to another agent
 * by database ID. The message is delivered via sendCustomMessage and
 * appears in the receiver agent's LLM context.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { type Static, Type } from '@sinclair/typebox';
import type { DatabaseClient } from '../../db/client.js';
import { log } from '../../utils/logger.js';
import { MAX_DELIVERY_BYTES } from '../host.js';
import type { AgentRegistry } from '../registry.js';

export function createMessageAgentTool(
  selfId: number,
  registry: AgentRegistry,
  db: DatabaseClient,
  maxDeliveryBytes: number = MAX_DELIVERY_BYTES
) {
  const messageAgentParams = Type.Object({
    agent_id: Type.Number({
      description:
        'The database ID of the agent to send a message to. Use read_system2_db to find agent IDs.',
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

  const tool: AgentTool<typeof messageAgentParams> = {
    name: 'message_agent',
    label: 'Message Agent',
    description:
      "Send a message to another agent in the system. The message appears in the receiver's context and triggers processing. Two delivery modes: default waits for the receiver to finish its current turn, urgent (urgent: true) interrupts mid-turn for time-sensitive corrections or priority changes. Use read_system2_db to look up available agents by role.",
    parameters: messageAgentParams,
    execute: async (_toolCallId, rawParams, signal) => {
      // pi-agent-core 0.71 (typebox-1) types execute params loosely (each
      // schema field as possibly undefined). Required fields are validated
      // before execute is called, so narrow once via the schema's Static type.
      const args = rawParams as Static<typeof messageAgentParams>;
      if (signal?.aborted) {
        return {
          content: [{ type: 'text', text: 'Aborted.' }],
          details: { error: 'aborted' },
        };
      }
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
      const content = `[${senderRole}_${selfId} message]\n\n${message}`;

      // Synchronous size pre-check: give the calling agent a clear error rather than
      // a fake-success result when the delivery would be silently dropped server-side.
      const messageBytes = Buffer.byteLength(content, 'utf8');
      if (messageBytes > maxDeliveryBytes) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: Message size ${messageBytes.toLocaleString()} bytes exceeds the inter-agent delivery cap of ${maxDeliveryBytes.toLocaleString()} bytes (configurable via [delivery] max_bytes in config.toml). Reduce the message size — for large data, write to a file and pass the path instead.`,
            },
          ],
          details: {
            error: 'message_too_large',
            message_bytes: messageBytes,
            max_bytes: maxDeliveryBytes,
          },
        };
      }

      const timestamp = Date.now();

      try {
        receiverHost
          .deliverMessage(content, { sender: selfId, receiver: agent_id, timestamp }, urgent)
          .catch((err) => log.error('[message-agent] delivery failed:', err));

        return {
          content: [
            {
              type: 'text',
              text: `Message delivered to ${receiverAgent.role}_${agent_id}. If you expect a response, set a 30-second reminder (set_reminder with delay_minutes: 0.5) to follow up.`,
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
