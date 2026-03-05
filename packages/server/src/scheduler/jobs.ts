/**
 * Scheduled Job Definitions
 *
 * Registers cron jobs that send messages to agents via deliverMessage().
 * Messages queue naturally — if the agent is busy, they wait.
 * sender: 0 is a sentinel for system-generated messages (no agent sender).
 */

import type { AgentHost } from '../agents/host.js';
import type { Scheduler } from './scheduler.js';

export function registerNarratorJobs(
  scheduler: Scheduler,
  narratorHost: AgentHost,
  narratorId: number
): void {
  // Daily log — every 30 minutes
  scheduler.schedule('daily-log', '*/30 * * * *', () => {
    console.log('[Scheduler] Triggering daily-log job');
    narratorHost.deliverMessage(
      "[Scheduled task: daily-log]\n\nAppend to today's daily log. Read activity since last_narrated timestamp.",
      { sender: 0, receiver: narratorId, timestamp: Date.now() }
    );
  });

  // Memory restructure — daily at 4 AM
  scheduler.schedule('memory-restructure', '0 4 * * *', () => {
    console.log('[Scheduler] Triggering memory-restructure job');
    narratorHost.deliverMessage(
      '[Scheduled task: memory-restructure]\n\nRestructure memory.md. Blend daily logs since last_restructured, consolidate Notes section.',
      { sender: 0, receiver: narratorId, timestamp: Date.now() }
    );
  });
}
