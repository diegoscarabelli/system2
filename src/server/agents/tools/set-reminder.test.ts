import { describe, expect, it, vi } from 'vitest';
import type { ReminderManager } from '../../reminders/manager.js';
import { createSetReminderTool } from './set-reminder.js';

function setup(existingReminderCount = 0) {
  const reminderManager = {
    schedule: vi.fn().mockReturnValue({ id: 1, fireAt: new Date('2026-01-01T12:05:00Z') }),
    listForAgent: vi
      .fn()
      .mockReturnValue(Array.from({ length: existingReminderCount }, (_, i) => i)),
  } as unknown as ReminderManager;
  const tool = createSetReminderTool(1, reminderManager);
  return { tool, reminderManager };
}

const { tool: _refTool } = setup();
type Params = Parameters<typeof _refTool.execute>[1];
type Result = Awaited<ReturnType<typeof _refTool.execute>>;

describe('set_reminder tool', () => {
  const exec = (tool: typeof _refTool, params: Record<string, unknown>): Promise<Result> =>
    tool.execute('test', params as Params);

  it('sets a reminder and returns confirmation', async () => {
    const { tool, reminderManager } = setup();

    const result = await exec(tool, { delay_minutes: 5, message: 'Check PR review' });

    expect(reminderManager.schedule).toHaveBeenCalledWith(1, 'Check PR review', 5);
    expect((result.content[0] as { text: string }).text).toContain('Reminder #1 set');
    expect((result.content[0] as { text: string }).text).toContain('5 minute(s)');
  });

  it('accepts 0.5 minutes (30 seconds) as minimum delay', async () => {
    const { tool, reminderManager } = setup();

    const result = await exec(tool, { delay_minutes: 0.5, message: 'quick check' });

    expect(reminderManager.schedule).toHaveBeenCalledWith(1, 'quick check', 0.5);
    expect((result.content[0] as { text: string }).text).toContain('Reminder #1 set');
  });

  it('rejects delay_minutes below minimum (0.5)', async () => {
    const { tool, reminderManager } = setup();

    const result = await exec(tool, { delay_minutes: 0.1, message: 'bad' });

    expect(reminderManager.schedule).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain('must be between');
  });

  it('rejects delay_minutes exceeding 7 days', async () => {
    const { tool, reminderManager } = setup();

    const result = await exec(tool, { delay_minutes: 10_081, message: 'too far' });

    expect(reminderManager.schedule).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain('must be between');
  });

  it('rejects when per-agent limit is reached', async () => {
    const { tool, reminderManager } = setup(10);

    const result = await exec(tool, { delay_minutes: 1, message: 'one more' });

    expect(reminderManager.schedule).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain('limit');
  });

  it('handles manager errors gracefully', async () => {
    const reminderManager = {
      schedule: vi.fn().mockImplementation(() => {
        throw new Error('timer failed');
      }),
      listForAgent: vi.fn().mockReturnValue([]),
    } as unknown as ReminderManager;
    const tool = createSetReminderTool(1, reminderManager);

    const result = await exec(tool, { delay_minutes: 5, message: 'boom' });

    expect((result.content[0] as { text: string }).text).toContain('timer failed');
  });
});
