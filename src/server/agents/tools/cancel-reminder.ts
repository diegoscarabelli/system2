import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { ReminderManager } from '../../reminders/manager.js';

export function createCancelReminderTool(agentId: number, reminderManager: ReminderManager) {
  const params = Type.Object({
    reminder_id: Type.Number({
      description: 'The ID of the reminder to cancel (returned by set_reminder).',
    }),
  });

  const tool: AgentTool<typeof params> = {
    name: 'cancel_reminder',
    label: 'Cancel Reminder',
    description: 'Cancel a pending reminder by its ID. Only your own reminders can be cancelled.',
    parameters: params,
    execute: async (_toolCallId, args) => {
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
