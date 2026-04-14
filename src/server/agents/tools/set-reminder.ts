import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { ReminderManager } from '../../reminders/manager.js';

const MIN_DELAY_MINUTES = 0.5; // 30 seconds
const MAX_DELAY_MINUTES = 10_080; // 7 days

export function createSetReminderTool(agentId: number, reminderManager: ReminderManager) {
  const params = Type.Object({
    delay_minutes: Type.Number({
      description: `How many minutes from now the reminder should fire. Must be between ${MIN_DELAY_MINUTES} (30 seconds) and ${MAX_DELAY_MINUTES} (7 days). Accepts fractional values (e.g. 0.5 for 30s, 1.5 for 90s).`,
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
      'Schedule a delayed reminder for yourself. After the specified delay, you will receive a follow-up message with your reminder text. Use this to defer actions: set the timer, continue your current work, and handle the reminder when it arrives. Write reminder messages as instructions to your future self, including agent IDs, task IDs, and the action to take. When a reminder fires and the condition it was set for is not yet satisfied (e.g. checking if another agent finished a job), set a new reminder rather than dropping the thread. Keep re-scheduling until the work completes or the situation changes. Reminders are in-memory only and do not survive server restarts; for longer delays, prefer a task comment and a check-on-startup pattern.',
    parameters: params,
    execute: async (_toolCallId, args) => {
      const { delay_minutes, message } = args;

      if (delay_minutes < MIN_DELAY_MINUTES || delay_minutes > MAX_DELAY_MINUTES) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: delay_minutes must be between ${MIN_DELAY_MINUTES} (30 seconds) and ${MAX_DELAY_MINUTES} (7 days).`,
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
