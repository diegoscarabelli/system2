/**
 * In-Process Scheduler
 *
 * Wraps croner to run periodic jobs. Jobs use deliverMessage() to queue
 * work for agents — messages queue naturally if the agent is busy.
 *
 * Note: croner does NOT catch up missed jobs after laptop sleep/shutdown.
 * Startup catch-up logic in server.ts handles this separately.
 */

import { Cron } from 'croner';

interface ScheduledJob {
  name: string;
  cron: Cron;
}

export class Scheduler {
  private jobs: ScheduledJob[] = [];

  /**
   * Schedule a recurring job.
   * @param name Human-readable job name for logging
   * @param pattern Cron expression (e.g., '*​/30 * * * *')
   * @param handler Function to execute on each trigger
   */
  schedule(name: string, pattern: string, handler: () => void | Promise<void>): void {
    const cron = new Cron(pattern, handler);
    this.jobs.push({ name, cron });
    console.log(`[Scheduler] Registered job "${name}" with pattern "${pattern}"`);
  }

  /**
   * Stop all scheduled jobs. Called during graceful shutdown.
   */
  stop(): void {
    for (const job of this.jobs) {
      job.cron.stop();
      console.log(`[Scheduler] Stopped job "${job.name}"`);
    }
    this.jobs = [];
  }
}
