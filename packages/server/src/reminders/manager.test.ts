import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentHost } from '../agents/host.js';
import type { AgentRegistry } from '../agents/registry.js';
import { ReminderManager } from './manager.js';

function makeRegistry(
  registeredAgents: Record<number, { deliverMessage: ReturnType<typeof vi.fn> }>
) {
  return {
    get: (id: number) => registeredAgents[id] as unknown as AgentHost | undefined,
  } as unknown as AgentRegistry;
}

describe('ReminderManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules a reminder and fires it after delay', () => {
    const deliverMessage = vi.fn();
    const registry = makeRegistry({ 1: { deliverMessage } });
    const manager = new ReminderManager(registry);

    const { id, fireAt } = manager.schedule(1, 'Check PR review', 5);

    expect(id).toBe(1);
    expect(fireAt).toBeInstanceOf(Date);
    expect(deliverMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5 * 60_000);

    expect(deliverMessage).toHaveBeenCalledTimes(1);
    const [content, details] = deliverMessage.mock.calls[0];
    expect(content).toContain('[Reminder #1]');
    expect(content).toContain('Check PR review');
    expect(details.sender).toBe(0);
    expect(details.receiver).toBe(1);
  });

  it('assigns incrementing IDs', () => {
    const registry = makeRegistry({ 1: { deliverMessage: vi.fn() } });
    const manager = new ReminderManager(registry);

    const r1 = manager.schedule(1, 'first', 10);
    const r2 = manager.schedule(1, 'second', 20);

    expect(r1.id).toBe(1);
    expect(r2.id).toBe(2);
  });

  it('cancels a pending reminder', () => {
    const deliverMessage = vi.fn();
    const registry = makeRegistry({ 1: { deliverMessage } });
    const manager = new ReminderManager(registry);

    const { id } = manager.schedule(1, 'will be cancelled', 5);
    const cancelled = manager.cancel(id, 1);

    expect(cancelled).toBe(true);

    vi.advanceTimersByTime(5 * 60_000);
    expect(deliverMessage).not.toHaveBeenCalled();
  });

  it('rejects cancel for wrong agent', () => {
    const registry = makeRegistry({ 1: { deliverMessage: vi.fn() } });
    const manager = new ReminderManager(registry);

    const { id } = manager.schedule(1, 'agent 1 reminder', 5);
    const cancelled = manager.cancel(id, 2);

    expect(cancelled).toBe(false);
  });

  it('rejects cancel for non-existent reminder', () => {
    const registry = makeRegistry({});
    const manager = new ReminderManager(registry);

    expect(manager.cancel(999, 1)).toBe(false);
  });

  it('lists reminders for a specific agent', () => {
    const registry = makeRegistry({
      1: { deliverMessage: vi.fn() },
      2: { deliverMessage: vi.fn() },
    });
    const manager = new ReminderManager(registry);

    manager.schedule(1, 'agent 1 reminder', 5);
    manager.schedule(2, 'agent 2 reminder', 10);
    manager.schedule(1, 'another agent 1', 15);

    const agent1Reminders = manager.listForAgent(1);
    expect(agent1Reminders).toHaveLength(2);
    expect(agent1Reminders[0].message).toBe('agent 1 reminder');
    expect(agent1Reminders[1].message).toBe('another agent 1');

    const agent2Reminders = manager.listForAgent(2);
    expect(agent2Reminders).toHaveLength(1);
  });

  it('removes reminder from list after firing', () => {
    const registry = makeRegistry({ 1: { deliverMessage: vi.fn() } });
    const manager = new ReminderManager(registry);

    manager.schedule(1, 'will fire', 5);
    expect(manager.listForAgent(1)).toHaveLength(1);

    vi.advanceTimersByTime(5 * 60_000);
    expect(manager.listForAgent(1)).toHaveLength(0);
  });

  it('logs warning and drops reminder when agent is not active', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = makeRegistry({}); // no agents registered
    const manager = new ReminderManager(registry);

    manager.schedule(1, 'orphaned reminder', 5);
    vi.advanceTimersByTime(5 * 60_000);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Agent 1 not active'));
    warnSpy.mockRestore();
  });

  it('stop() clears all timers', () => {
    const deliverMessage = vi.fn();
    const registry = makeRegistry({ 1: { deliverMessage } });
    const manager = new ReminderManager(registry);

    manager.schedule(1, 'reminder 1', 5);
    manager.schedule(1, 'reminder 2', 10);
    manager.stop();

    vi.advanceTimersByTime(10 * 60_000);
    expect(deliverMessage).not.toHaveBeenCalled();
    expect(manager.listForAgent(1)).toHaveLength(0);
  });
});
