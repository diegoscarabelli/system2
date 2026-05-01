/**
 * Start Command
 *
 * Starts the System2 server in the background (detached) with logs to file.
 * Cross-platform: works on macOS, Linux, and Windows.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import open from 'open';
import type { LlmConfig } from '../../shared/index.js';
import { backupIfNeeded } from '../utils/backup.js';
import { loadConfig, SYSTEM2_DIR } from '../utils/config.js';
import { rotateLogIfNeeded } from '../utils/log-rotation.js';

/**
 * Build the auth-tier lines for the startup banner. Returns one line per
 * configured tier (OAuth and/or API keys), each showing the full
 * primary→fallback chain so the user sees what failover order will run.
 *
 * Rules:
 *   - OAuth line shown only when `[llm.oauth]` is set in config.
 *   - API-keys line shown only when at least one provider in
 *     `llm.providers` has a non-empty keys array. The synthesized
 *     `LlmConfig.primary` default (which exists even when the user
 *     skipped api-keys at onboarding — see onboard.ts:594-605) is
 *     intentionally NOT enough to show the line; we mirror the
 *     buildConfigToml emit-template-when-empty rule so the banner
 *     reflects what's actually usable.
 */
export function formatTierBanner(llm: LlmConfig): string[] {
  const lines: string[] = [];
  if (llm.oauth) {
    const chain = [llm.oauth.primary, ...llm.oauth.fallback].join(' → ');
    lines.push(`  OAuth tier:   ${chain}`);
  }
  const apiKeysConfigured = Object.values(llm.providers).some((p) => p && p.keys.length > 0);
  if (apiKeysConfigured) {
    const chain = [llm.primary, ...llm.fallback].join(' → ');
    lines.push(`  API key tier: ${chain}`);
  }
  return lines;
}

const LOGS_DIR = join(SYSTEM2_DIR, 'logs');
const PID_FILE = join(SYSTEM2_DIR, 'server.pid');
const LOG_FILE = join(LOGS_DIR, 'system2.log');
const IS_WINDOWS = process.platform === 'win32';

export async function start(options: {
  port?: number;
  noBrowser?: boolean;
  foreground?: boolean;
}): Promise<void> {
  // Check if onboarded
  const config = loadConfig();
  if (!config.llm) {
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

  const port = options.port || 4242;

  // Automatic backup (only in normal start mode, not foreground spawned by background)
  if (!options.foreground) {
    backupIfNeeded();
  }

  const tierLines = formatTierBanner(config.llm);
  if (tierLines.length === 0) {
    // Onboarding enforces "at least one auth tier configured"; reaching
    // here means config.toml was edited to remove all credentials.
    console.error(
      'Error: No auth tier configured. Add OAuth credentials via `system2 login` ' +
        'or API keys to `[llm.api_keys.<provider>].keys` in config.toml.'
    );
    process.exit(1);
  }

  console.log('Starting System2 Gateway...');
  for (const line of tierLines) {
    console.log(line);
  }
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

    const { Server } = await import('../../server/index.js');
    const server = new Server({
      port,
      dbPath: join(SYSTEM2_DIR, 'app.db'),
      uiDistPath: join(dirname(fileURLToPath(import.meta.url)), '..', 'ui'),
      llmConfig: config.llm,
      servicesConfig: config.services,
      toolsConfig: config.tools,
      schedulerConfig: config.scheduler
        ? { daily_summary_interval_minutes: config.scheduler.dailySummaryIntervalMinutes }
        : undefined,
      chatConfig: config.chat
        ? { max_history_messages: config.chat.maxHistoryMessages }
        : undefined,
      knowledgeConfig: { budget_chars: config.knowledge.budgetChars },
      databasesConfig: config.databases,
      agentsConfig: config.agents,
      deliveryConfig: config.delivery,
      sessionConfig: config.session,
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
        ...(port !== 4242 ? ['--port', port.toString()] : []),
      ],
      {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: process.env,
        windowsHide: true,
      }
    );

    // Save PID
    writeFileSync(PID_FILE, String(child.pid ?? ''));

    // Detach from parent
    child.unref();

    console.log('✅ System2 started in background');
    console.log(`  PID: ${child.pid}`);
    console.log(`  Logs: ${LOG_FILE}`);
    console.log('');
    console.log(
      IS_WINDOWS
        ? `To view logs: Get-Content "${LOG_FILE}" -Wait`
        : `To view logs: tail -f ${LOG_FILE}`
    );
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
