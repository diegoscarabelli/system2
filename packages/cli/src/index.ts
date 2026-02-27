#!/usr/bin/env node
/**
 * System2 CLI
 *
 * Command-line interface for System2.
 */

import { Command } from 'commander';
import { onboard } from './commands/onboard.js';

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

// TODO: Add 'start' command for subsequent runs (after onboarding)

program.parse();
