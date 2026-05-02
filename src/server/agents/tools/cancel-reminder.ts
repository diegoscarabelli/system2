import type { AgentTool } from '@mariozechner/pi-agent-core';
import { type Static, Type } from '@sinclair/typebox';
import type { ReminderManager } from '../../reminders/manager.js';

export function createCancelReminderTool(agentId: number, reminderManager: ReminderManager) {
  const cancelReminderParams = Type.Object({
    reminder_id: Type.Number({
      description: 'The ID of the reminder to cancel (returned by set_reminder).',
    }),
  });

  const tool: AgentTool<typeof cancelReminderParams> = {
    name: 'cancel_reminder',
    label: 'Cancel Reminder',
    description: 'Cancel a pending reminder by its ID. Only your own reminders can be cancelled.',
    parameters: cancelReminderParams,
    execute: async (_toolCallId, rawParams) => {
      // pi-agent-core 0.71 (typebox-1) types execute params loosely (each
      // schema field as possibly undefined). Required fields are validated
      // before execute is called, so narrow once via the schema's Static type.
      const args = rawParams as Static<typeof cancelReminderParams>;
      try {
        const cancelled = reminderManager.cancel(args.reminder_id, agentId);
        if (!cancelled) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Reminder #${args.reminder_id} not found, not yours, or already fired/cancelled.`,
              },
            ],
            details: { cancelled: false },
          };
        }
        return {
          content: [{ type: 'text' as const, text: `Reminder #${args.reminder_id} cancelled.` }],
          details: { cancelled: true, reminder_id: args.reminder_id },
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
          details: { error: (error as Error).message },
        };
      }
    },
  };

  return tool;
}
