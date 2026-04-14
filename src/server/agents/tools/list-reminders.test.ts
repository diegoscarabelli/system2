import { describe, expect, it, vi } from 'vitest';
import type { ReminderManager } from '../../reminders/manager.js';
import { createListRemindersTool } from './list-reminders.js';

function setup(
  reminders: Array<{ id: number; agentId: number; message: string; fireAt: Date }> = []
) {
  const reminderManager = {
    listForAgent: vi.fn().mockReturnValue(reminders),
  } as unknown as ReminderManager;
  const tool = createListRemindersTool(1, reminderManager);
  return { tool, reminderManager };
}

const { tool: _refTool } = setup();
type Result = Awaited<ReturnType<typeof _refTool.execute>>;

describe('list_reminders tool', () => {
  const exec = (tool: typeof _refTool): Promise<Result> =>
    tool.execute('test', {} as Parameters<typeof _refTool.execute>[1]);

  it('returns empty message when no reminders', async () => {
    const { tool, reminderManager } = setup([]);

    const result = await exec(tool);

    expect(reminderManager.listForAgent).toHaveBeenCalledWith(1);
    expect((result.content[0] as { text: string }).text).toBe('No pending reminders.');
    expect(result.details).toEqual({ count: 0, reminders: [] });
  });

  it('lists pending reminders', async () => {
    const { tool } = setup([
      { id: 1, agentId: 1, message: 'Check PR', fireAt: new Date('2026-01-01T12:05:00Z') },
      { id: 3, agentId: 1, message: 'Follow up', fireAt: new Date('2026-01-01T13:00:00Z') },
    ]);

    const result = await exec(tool);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('#1:');
    expect(text).toContain('Check PR');
    expect(text).toContain('#3:');
    expect(text).toContain('Follow up');
    expect(result.details).toEqual({
      count: 2,
      reminders: expect.arrayContaining([expect.objectContaining({ id: 1 })]),
    });
  });

  it('handles manager errors gracefully', async () => {
    const reminderManager = {
      listForAgent: vi.fn().mockImplementation(() => {
        throw new Error('list failed');
      }),
    } as unknown as ReminderManager;
    const tool = createListRemindersTool(1, reminderManager);

    const result = await exec(tool);

    expect((result.content[0] as { text: string }).text).toContain('list failed');
  });
});
