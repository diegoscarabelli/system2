import { describe, expect, it, vi } from 'vitest';
import type { ReminderManager } from '../../reminders/manager.js';
import { createSetReminderTool } from './set-reminder.js';

function setup() {
  const reminderManager = {
    schedule: vi.fn().mockReturnValue({ id: 1, fireAt: new Date('2026-01-01T12:05:00Z') }),
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

  it('rejects delay_minutes < 1 (including fractional sub-minute values)', async () => {
    const { tool, reminderManager } = setup();

    const result0 = await exec(tool, { delay_minutes: 0, message: 'bad' });
    expect(reminderManager.schedule).not.toHaveBeenCalled();
    expect((result0.content[0] as { text: string }).text).toContain('must be between 1 and');

    const result05 = await exec(tool, { delay_minutes: 0.5, message: 'bad' });
    expect(reminderManager.schedule).not.toHaveBeenCalled();
    expect((result05.content[0] as { text: string }).text).toContain('must be between 1 and');
  });

  it('rejects delay_minutes exceeding setTimeout limit (~24.8 days)', async () => {
    const { tool, reminderManager } = setup();

    const result = await exec(tool, { delay_minutes: 40_000, message: 'too far' });

    expect(reminderManager.schedule).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain('must be between 1 and');
  });

  it('handles manager errors gracefully', async () => {
    const reminderManager = {
      schedule: vi.fn().mockImplementation(() => {
        throw new Error('timer failed');
      }),
    } as unknown as ReminderManager;
    const tool = createSetReminderTool(1, reminderManager);

    const result = await exec(tool, { delay_minutes: 5, message: 'boom' });

    expect((result.content[0] as { text: string }).text).toContain('timer failed');
  });
});
