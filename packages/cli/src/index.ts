#!/usr/bin/env node
/**
 * System2 CLI
 *
 * Command-line interface for System2.
 */

import { Command } from 'commander';
import { onboard } from './commands/onboard.js';
import { start } from './commands/start.js';
import { stop } from './commands/stop.js';
import { status } from './commands/status.js';

const program = new Command();

program
  .name('system2')
  .description('A multi-agent data platform for solo analysts')
  .version('0.1.0');

program
  .command('onboard')
  .description('Initialize System2 and configure LLM providers')
  .action(async () => {
    await onboard();
  });

program
  .command('start')
  .description('Start the System2 gateway server (after onboarding)')
  .option('-p, --port <number>', 'Port to run the server on', '3000')
  .option('--no-browser', 'Do not open browser automatically')
  .option('--foreground', 'Run in foreground (for debugging)')
  .action(async (options) => {
    await start({
      port: options.port ? parseInt(options.port) : undefined,
      noBrowser: !options.browser,
      foreground: options.foreground,
    });
  });

program
  .command('stop')
  .description('Stop the System2 gateway server')
  .action(async () => {
    await stop();
  });

program
  .command('status')
  .description('Show System2 gateway server status')
  .action(async () => {
    await status();
  });

program.parse();
