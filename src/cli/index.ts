#!/usr/bin/env node
/**
 * System2 CLI
 *
 * Command-line interface for System2.
 */

import { createRequire } from 'node:module';
import { Command } from 'commander';
import { config } from './commands/config.js';
import { init } from './commands/init.js';
import { start } from './commands/start.js';
import { status } from './commands/status.js';
import { stop } from './commands/stop.js';
import { checkForUpdates } from './utils/update-notifier.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

const program = new Command();

program
  .name('system2')
  .description('The AI multi-agent system for working with data')
  .version(pkg.version)
  .hook('preAction', () => checkForUpdates(pkg.version));

program
  .command('init')
  .description('Create ~/.system2/ and launch interactive configuration')
  .action(async () => {
    await init();
  });

program
  .command('config')
  .description('Manage LLM credentials and services (OAuth, API keys, Brave Search)')
  .action(async () => {
    await config();
  });

program
  .command('start')
  .description('Start the System2 server (after `system2 init`)')
  .option('-p, --port <number>', 'Port to run the server on', '4242')
  .option('--no-browser', 'Do not open browser automatically')
  .option('--foreground', 'Run in foreground (for debugging)')
  .action(async (options) => {
    await start({
      port: options.port ? parseInt(options.port, 10) : undefined,
      noBrowser: !options.browser,
      foreground: options.foreground,
    });
  });

program
  .command('stop')
  .description('Stop the System2 server')
  .action(async () => {
    await stop();
  });

program
  .command('status')
  .description('Show System2 server status')
  .action(async () => {
    await status();
  });

program.parse();
