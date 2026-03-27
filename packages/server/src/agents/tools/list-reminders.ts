import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { ReminderManager } from '../../reminders/manager.js';

export function createListRemindersTool(agentId: number, reminderManager: ReminderManager) {
  const params = Type.Object({});

  const tool: AgentTool<typeof params> = {
    name: 'list_reminders',
    label: 'List Reminders',
    description:
      'List your active (pending) reminders. Shows reminder ID, message, and scheduled fire time.',
    parameters: params,
    execute: async () => {
      try {
        const reminders = reminderManager.listForAgent(agentId);
        if (reminders.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No pending reminders.' }],
            details: { count: 0, reminders: [] },
          };
        }
        const lines = reminders.map(
          (r) => `#${r.id}: fires at ${r.fireAt.toISOString()} — "${r.message}"`
        );
        return {
          content: [{ type: 'text' as const, text: `Pending reminders:\n${lines.join('\n')}` }],
          details: { count: reminders.length, reminders },
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
