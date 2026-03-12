/**
 * Stop Command
 *
 * Stops the System2 server. Cross-platform: uses signals on Unix, taskkill on Windows.
 */

import { exec } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const SYSTEM2_DIR = join(homedir(), '.system2');
const PID_FILE = join(SYSTEM2_DIR, 'server.pid');
const IS_WINDOWS = process.platform === 'win32';

/**
 * Check if a process is running by PID.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process. Uses taskkill on Windows, signals on Unix.
 */
async function killProcess(pid: number, force: boolean): Promise<void> {
  if (IS_WINDOWS) {
    const flag = force ? '/F' : '';
    await execAsync(`taskkill /PID ${pid} ${flag}`.trim());
  } else {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  }
}

export async function stop(): Promise<void> {
  // Check if PID file exists
  if (!existsSync(PID_FILE)) {
    console.log('System2 is not running');
    console.log('');
    console.log('To start: system2 start');
    process.exit(0);
  }

  const pid = parseInt(readFileSync(PID_FILE, 'utf-8'), 10);

  try {
    // Check if process exists
    if (!isProcessRunning(pid)) {
      console.log('System2 was not running (removing stale PID file)');
      unlinkSync(PID_FILE);
      return;
    }

    // Process exists, request graceful shutdown
    console.log(`Stopping System2 (PID: ${pid})...`);
    await killProcess(pid, false);

    // Poll for exit (up to 10 seconds) instead of a fixed wait
    const deadline = Date.now() + 10_000;
    while (isProcessRunning(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // Force kill if graceful shutdown didn't complete in time
    if (isProcessRunning(pid)) {
      console.log('Process still running, forcing shutdown...');
      await killProcess(pid, true);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Clean up PID file
    unlinkSync(PID_FILE);
    console.log('✓ System2 stopped');
  } catch (_error) {
    // Process not running or already terminated, clean up stale PID file
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }
    console.log('✓ System2 stopped');
  }
}
