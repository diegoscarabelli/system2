/**
 * Status Command
 *
 * Shows the current status of the System2 server.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE, SYSTEM2_DIR } from '../utils/config.js';

const IS_WINDOWS = process.platform === 'win32';
const PID_FILE = join(SYSTEM2_DIR, 'server.pid');
const LOG_FILE = join(SYSTEM2_DIR, 'logs', 'system2.log');

export async function status(): Promise<void> {
  console.log('System2 Status');
  console.log('─────────────────────────────────────');
  console.log('');

  // Check if configured
  if (!existsSync(CONFIG_FILE)) {
    console.log('Status: Not configured');
    console.log('');
    console.log('Run: system2 init');
    process.exit(0);
  }

  // Check if running
  if (!existsSync(PID_FILE)) {
    console.log('Status: Stopped');
    console.log('');
    console.log('To start: system2 start');
    process.exit(0);
  }

  const pid = parseInt(readFileSync(PID_FILE, 'utf-8'), 10);

  try {
    // Check if process exists
    process.kill(pid, 0);

    console.log('Status: Running ✓');
    console.log(`PID: ${pid}`);
    console.log('');

    // Show log file info
    if (existsSync(LOG_FILE)) {
      const stats = statSync(LOG_FILE);
      const sizeInMB = (stats.size / 1024 / 1024).toFixed(2);
      console.log(`Log file: ${LOG_FILE}`);
      console.log(`Log size: ${sizeInMB} MB`);
      console.log('');
    }

    console.log('Commands:');
    console.log('  system2 stop              Stop the server');
    console.log(IS_WINDOWS ? `  Get-Content "${LOG_FILE}" -Wait` : `  tail -f ${LOG_FILE}`);
    console.log('                            View live logs');
  } catch {
    // Process not running
    console.log('Status: Stopped (stale PID file)');
    console.log('');
    console.log('Run: system2 start');
  }
}
