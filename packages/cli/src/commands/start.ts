/**
 * Start Command
 *
 * Starts the System2 gateway server in the background (detached) with logs to file.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import open from 'open';
import { backupIfNeeded } from '../utils/backup.js';
import { rotateLogIfNeeded } from '../utils/log-rotation.js';

const SYSTEM2_DIR = join(homedir(), '.system2');
const AUTH_FILE = join(SYSTEM2_DIR, 'auth.json');
const LOGS_DIR = join(SYSTEM2_DIR, 'logs');
const PID_FILE = join(SYSTEM2_DIR, 'server.pid');
const LOG_FILE = join(LOGS_DIR, 'system2.log');

export async function start(options: {
  port?: number;
  noBrowser?: boolean;
  foreground?: boolean;
}): Promise<void> {
  // Check if onboarded
  if (!existsSync(AUTH_FILE)) {
    console.error('Error: System2 has not been onboarded yet.');
    console.error('Please run: system2 onboard');
    process.exit(1);
  }

  // Check if already running (skip if we're in foreground mode - spawned by background process)
  if (!options.foreground && existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8'), 10);
    try {
      process.kill(pid, 0); // Check if process exists
      console.log('System2 is already running!');
      console.log(`  PID: ${pid}`);
      console.log(`  Logs: ${LOG_FILE}`);
      console.log('');
      console.log('To stop: system2 stop');
      process.exit(0);
    } catch {
      // Process not running, remove stale PID file
      console.log('Removing stale PID file...');
      unlinkSync(PID_FILE);
    }
  }

  // Read primary provider from auth.json
  const authConfig = JSON.parse(readFileSync(AUTH_FILE, 'utf-8'));
  const primaryProvider = authConfig.primary as 'anthropic' | 'openai' | 'google';

  if (!primaryProvider) {
    console.error('Error: No primary provider configured in auth.json');
    process.exit(1);
  }

  const port = options.port || 3000;

  // Automatic backup (only in normal start mode, not foreground spawned by background)
  if (!options.foreground) {
    backupIfNeeded();
  }

  console.log('Starting System2 Gateway...');
  console.log(`  Provider: ${primaryProvider}`);
  console.log(`  Port: ${port}`);
  console.log('');

  // Create logs directory
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }

  // Rotate log file if needed (before starting server)
  rotateLogIfNeeded({ logFile: LOG_FILE });

  if (options.foreground) {
    // Run in foreground (for debugging)
    console.log('Running in foreground mode...');
    console.log('Press Ctrl+C to stop');
    console.log('');

    const { Server } = await import('@system2/gateway');
    const server = new Server({
      port,
      dbPath: join(SYSTEM2_DIR, 'app.db'),
      uiDistPath: join(import.meta.dirname, '..', '..', 'ui', 'dist'),
    });

    await server.start();

    if (!options.noBrowser) {
      await open(`http://localhost:${port}`);
    }

    // Keep server running
    await new Promise(() => {});
  } else {
    // Run in background (detached) - just use foreground mode but spawn it
    const { openSync } = await import('node:fs');
    const logFd = openSync(LOG_FILE, 'a');

    const child = spawn(
      process.execPath,
      [
        process.argv[1], // Path to system2 CLI
        'start',
        '--foreground',
        '--no-browser',
        ...(port !== 3000 ? ['--port', port.toString()] : []),
      ],
      {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: process.env,
      }
    );

    // Save PID
    writeFileSync(PID_FILE, child.pid?.toString());

    // Detach from parent
    child.unref();

    console.log('✅ System2 started in background');
    console.log(`  PID: ${child.pid}`);
    console.log(`  Logs: ${LOG_FILE}`);
    console.log('');
    console.log(`To view logs: tail -f ${LOG_FILE}`);
    console.log('To stop: system2 stop');
    console.log('');

    // Wait a moment then check if it's running
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Open browser
    if (!options.noBrowser) {
      console.log('Opening browser...');
      await open(`http://localhost:${port}`);
    }
  }
}
