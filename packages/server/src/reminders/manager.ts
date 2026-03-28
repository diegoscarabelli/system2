/**
 * Reminder Manager
 *
 * In-memory manager for agent reminders. Agents schedule reminders with a delay,
 * and when the timer fires, a follow-up message is delivered back to the agent
 * via deliverMessage(). Reminders do not survive server restarts.
 */

import type { AgentRegistry } from '../agents/registry.js';

export interface PendingReminder {
  id: number;
  agentId: number;
  message: string;
  fireAt: Date;
}

/** Internal representation including the timer handle. */
interface StoredReminder extends PendingReminder {
  timer: NodeJS.Timeout;
}

export class ReminderManager {
  private nextId = 1;
  private reminders: Map<number, StoredReminder> = new Map();

  constructor(private registry: AgentRegistry) {}

  /** Schedule a reminder that fires after `delayMinutes`. Returns the ID and fire time. */
  schedule(agentId: number, message: string, delayMinutes: number): { id: number; fireAt: Date } {
    const id = this.nextId++;
    const delayMs = delayMinutes * 60_000;
    const fireAt = new Date(Date.now() + delayMs);

    const timer = setTimeout(() => this.fire(id), delayMs);
    // Prevent the timer from keeping the Node.js process alive during shutdown
    timer.unref();

    this.reminders.set(id, { id, agentId, message, fireAt, timer });
    return { id, fireAt };
  }

  /** Cancel a pending reminder. Returns true if cancelled, false if not found or not owned. */
  cancel(reminderId: number, agentId: number): boolean {
    const reminder = this.reminders.get(reminderId);
    if (!reminder || reminder.agentId !== agentId) return false;

    clearTimeout(reminder.timer);
    this.reminders.delete(reminderId);
    return true;
  }

  /** List pending reminders for a given agent. */
  listForAgent(agentId: number): PendingReminder[] {
    const results: PendingReminder[] = [];
    for (const r of this.reminders.values()) {
      if (r.agentId === agentId) {
        results.push({ id: r.id, agentId: r.agentId, message: r.message, fireAt: r.fireAt });
      }
    }
    results.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
    return results;
  }

  /** Clear all active timers. Called on graceful shutdown. */
  stop(): void {
    for (const r of this.reminders.values()) {
      clearTimeout(r.timer);
    }
    this.reminders.clear();
  }

  /** Fire a reminder: deliver the message and remove it from the map. */
  private fire(reminderId: number): void {
    const reminder = this.reminders.get(reminderId);
    if (!reminder) return;

    this.reminders.delete(reminderId);

    const host = this.registry.get(reminder.agentId);
    if (!host) {
      console.warn(
        `[ReminderManager] Agent ${reminder.agentId} not active, dropping reminder #${reminderId}`
      );
      return;
    }

    const content = `[Reminder #${reminderId}]\n\n${reminder.message}`;
    host
      .deliverMessage(content, { sender: 0, receiver: reminder.agentId, timestamp: Date.now() })
      .catch((err) => console.error('[ReminderManager] delivery failed:', err));
  }
}
