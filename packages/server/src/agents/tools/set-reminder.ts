import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { ReminderManager } from '../../reminders/manager.js';

// Node.js setTimeout clamps delays > 2^31-1 ms, causing them to fire immediately.
const MAX_DELAY_MINUTES = 35_791; // ~24.8 days

export function createSetReminderTool(agentId: number, reminderManager: ReminderManager) {
  const params = Type.Object({
    delay_minutes: Type.Number({
      description: `How many minutes from now the reminder should fire. Must be between 1 and ${MAX_DELAY_MINUTES} (~24.8 days).`,
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

      if (delay_minutes < 1 || delay_minutes > MAX_DELAY_MINUTES) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: delay_minutes must be between 1 and ${MAX_DELAY_MINUTES} (~24.8 days).`,
            },
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
