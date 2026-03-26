import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { ReminderManager } from '../../reminders/manager.js';

export function createSetReminderTool(agentId: number, reminderManager: ReminderManager) {
  const params = Type.Object({
    delay_minutes: Type.Number({
      description: 'How many minutes from now the reminder should fire. Must be greater than 0.',
    }),
    message: Type.String({
      description:
        'The reminder message. Describe what you need to do when the timer fires. This text will be delivered back to you as a follow-up message.',
    }),
  });

  const tool: AgentTool<typeof params> = {
    name: 'set_reminder',
    label: 'Set Reminder',
    description:
      'Schedule a delayed reminder for yourself. After the specified delay, you will receive a follow-up message with your reminder text. Use this to defer actions: set the timer, continue your current work, and handle the reminder when it arrives.',
    parameters: params,
    execute: async (_toolCallId, args) => {
      const { delay_minutes, message } = args;

      if (delay_minutes <= 0) {
        return {
          content: [
            { type: 'text' as const, text: 'Error: delay_minutes must be greater than 0.' },
          ],
          details: { error: 'invalid_delay' },
        };
      }

      try {
        const { id, fireAt } = reminderManager.schedule(agentId, message, delay_minutes);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Reminder #${id} set. It will fire in ${delay_minutes} minute(s) (around ${fireAt.toISOString()}). You will receive a follow-up message with your reminder text. Continue your current work.`,
            },
          ],
          details: { reminder_id: id, fire_at: fireAt.toISOString() },
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: `Error setting reminder: ${(error as Error).message}` },
          ],
          details: { error: (error as Error).message },
        };
      }
    },
  };

  return tool;
}
