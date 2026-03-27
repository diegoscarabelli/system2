import { describe, expect, it, vi } from 'vitest';
import type { ReminderManager } from '../../reminders/manager.js';
import { createCancelReminderTool } from './cancel-reminder.js';

function setup(cancelResult = true) {
  const reminderManager = {
    cancel: vi.fn().mockReturnValue(cancelResult),
  } as unknown as ReminderManager;
  const tool = createCancelReminderTool(1, reminderManager);
  return { tool, reminderManager };
}

const { tool: _refTool } = setup();
type Params = Parameters<typeof _refTool.execute>[1];
type Result = Awaited<ReturnType<typeof _refTool.execute>>;

describe('cancel_reminder tool', () => {
  const exec = (tool: typeof _refTool, params: Record<string, unknown>): Promise<Result> =>
    tool.execute('test', params as Params);

  it('cancels a reminder successfully', async () => {
    const { tool, reminderManager } = setup(true);

    const result = await exec(tool, { reminder_id: 42 });

    expect(reminderManager.cancel).toHaveBeenCalledWith(42, 1);
    expect((result.content[0] as { text: string }).text).toContain('#42 cancelled');
    expect(result.details).toEqual({ cancelled: true, reminder_id: 42 });
  });

  it('reports failure when reminder not found or not owned', async () => {
    const { tool } = setup(false);

    const result = await exec(tool, { reminder_id: 99 });

    expect((result.content[0] as { text: string }).text).toContain('#99 not found');
    expect(result.details).toEqual({ cancelled: false });
  });

  it('handles manager errors gracefully', async () => {
    const reminderManager = {
      cancel: vi.fn().mockImplementation(() => {
        throw new Error('cancel failed');
      }),
    } as unknown as ReminderManager;
    const tool = createCancelReminderTool(1, reminderManager);

    const result = await exec(tool, { reminder_id: 1 });

    expect((result.content[0] as { text: string }).text).toContain('cancel failed');
  });
});
