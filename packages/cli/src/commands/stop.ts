/**
 * Stop Command
 *
 * Stops the System2 server. Cross-platform: uses signals on Unix, taskkill on Windows.
 * Uses two strategies: PID file lookup and port-based detection (fallback for orphaned processes).
 */

import { exec } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const SYSTEM2_DIR = join(homedir(), '.system2');
const PID_FILE = join(SYSTEM2_DIR, 'server.pid');
const DEFAULT_PORT = 3000;
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
 * Treats ESRCH (process already exited) as success.
 */
async function killProcess(pid: number, force: boolean): Promise<void> {
  try {
    if (IS_WINDOWS) {
      const flag = force ? '/F' : '';
      await execAsync(`taskkill /PID ${pid} ${flag}`.trim());
    } else {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch (err: unknown) {
    // Process already exited between our check and the kill signal: that's fine
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ESRCH') {
      return;
    }
    throw err;
  }
}

/**
 * Wait for a process to exit, with a deadline.
 * Returns true if the process exited, false if it's still running.
 */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessRunning(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return !isProcessRunning(pid);
}

/**
 * Gracefully stop a process: SIGTERM, wait, then SIGKILL if needed.
 */
async function stopProcess(pid: number, label: string): Promise<void> {
  console.log(`Stopping ${label} (PID: ${pid})...`);
  await killProcess(pid, false);

  if (await waitForExit(pid, 10_000)) {
    return;
  }

  console.log('Process still running, forcing shutdown...');
  await killProcess(pid, true);
  await new Promise((resolve) => setTimeout(resolve, 500));

  if (isProcessRunning(pid)) {
    throw new Error(`Failed to stop process ${pid}`);
  }
}

/**
 * Find the PID of a process listening on a TCP port.
 * Returns undefined if no process is found or on error.
 */
async function findListenerPid(port: number): Promise<number | undefined> {
  try {
    if (IS_WINDOWS) {
      const { stdout } = await execAsync(
        `netstat -ano | findstr "LISTENING" | findstr ":${port} "`
      );
      const match = stdout.trim().split(/\s+/).pop();
      return match ? parseInt(match, 10) : undefined;
    }
    // Unix: lsof returns the PID of the process listening on the port
    const { stdout } = await execAsync(`lsof -i :${port} -t -s TCP:LISTEN`);
    const pid = parseInt(stdout.trim(), 10);
    return Number.isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

export async function stop(): Promise<void> {
  let stopped = false;
  let pidFromFile: number | undefined;
  let hadPidFile = false;

  // Strategy 1: PID file
  if (existsSync(PID_FILE)) {
    hadPidFile = true;
    const raw = parseInt(readFileSync(PID_FILE, 'utf-8'), 10);
    pidFromFile = Number.isNaN(raw) ? undefined : raw;

    if (pidFromFile && isProcessRunning(pidFromFile)) {
      try {
        await stopProcess(pidFromFile, 'System2');
        stopped = true;
      } catch {
        console.error(`Failed to stop System2 (PID: ${pidFromFile}). Kill it manually.`);
        process.exit(1);
      }
    }

    unlinkSync(PID_FILE);
  }

  // Strategy 2: check port for orphaned processes the PID file missed.
  // Only runs when a PID file existed (evidence system2 was running), to avoid
  // killing unrelated services that happen to use the same port.
  if (hadPidFile) {
    const listenerPid = await findListenerPid(DEFAULT_PORT);

    if (listenerPid && listenerPid !== pidFromFile) {
      console.log(`Found orphaned System2 process on port ${DEFAULT_PORT} (PID: ${listenerPid})`);
      try {
        await stopProcess(listenerPid, 'orphaned process');
        stopped = true;
      } catch {
        console.error(`Failed to stop orphaned process (PID: ${listenerPid}). Kill it manually.`);
        process.exit(1);
      }
    }
  }

  if (stopped) {
    console.log('✓ System2 stopped');
  } else {
    console.log('System2 is not running');
    console.log('');
    console.log('To start: system2 start');
  }
}
