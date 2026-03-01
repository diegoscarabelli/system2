/**
 * Stop Command
 *
 * Stops the System2 gateway server.
 */

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SYSTEM2_DIR = join(homedir(), '.system2');
const PID_FILE = join(SYSTEM2_DIR, 'server.pid');

export async function stop(): Promise<void> {
  // Check if PID file exists
  if (!existsSync(PID_FILE)) {
    console.log('System2 is not running');
    console.log('');
    console.log('To start: system2 start');
    process.exit(0);
  }

  const pid = parseInt(readFileSync(PID_FILE, 'utf-8'));

  try {
    // Check if process exists
    process.kill(pid, 0);

    // Process exists, send SIGTERM for graceful shutdown
    console.log(`Stopping System2 (PID: ${pid})...`);
    process.kill(pid, 'SIGTERM');

    // Wait a bit for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check if still running
    try {
      process.kill(pid, 0);
      // Still running, force kill
      console.log('Process still running, forcing shutdown...');
      process.kill(pid, 'SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch {
      // Process stopped gracefully
    }

    // Clean up PID file
    unlinkSync(PID_FILE);
    console.log('✓ System2 stopped');
  } catch (error) {
    // Process not running, clean up stale PID file
    console.log('System2 was not running (removing stale PID file)');
    unlinkSync(PID_FILE);
  }
}
