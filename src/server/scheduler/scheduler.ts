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
import { log } from '../utils/logger.js';
import { HandlerTimeoutError } from './jobs.js';

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
    // Safety net at the cron→handler boundary: a rejected handler promise
    // would otherwise propagate up through Croner's `_trigger` (which does
    // NOT catch by default) and surface as an unhandled rejection, which
    // Node 25 treats as an uncaught exception and exits the process.
    // The DB-level "failed" record is already written inside trackJobExecution;
    // this just keeps the daemon alive so future ticks can recover.
    const safeHandler = async (): Promise<void> => {
      try {
        await handler();
      } catch (error) {
        // Handler timeouts are already recorded on the DB row by
        // trackJobExecution — log them at `warn` with a distinct phrasing so
        // log-based alerting on genuine `handler error (uncaught)` (an actual
        // scheduler-level crash) is not diluted by expected-but-noisy timeout
        // events (issue #203).
        if (error instanceof HandlerTimeoutError) {
          log.warn(`[Scheduler] Job "${name}" timed out:`, error);
        } else {
          log.error(`[Scheduler] Job "${name}" handler error (uncaught):`, error);
        }
      }
    };
    const cron = new Cron(pattern, safeHandler);
    this.jobs.push({ name, cron });
    log.info(`[Scheduler] Registered job "${name}" with pattern "${pattern}"`);
  }

  /**
   * Stop all scheduled jobs. Called during graceful shutdown.
   */
  stop(): void {
    for (const job of this.jobs) {
      job.cron.stop();
      log.info(`[Scheduler] Stopped job "${job.name}"`);
    }
    this.jobs = [];
  }
}
