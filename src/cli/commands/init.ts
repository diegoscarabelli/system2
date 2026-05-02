/**
 * Init Command
 *
 * Scaffolds ~/.system2/ on a fresh install: creates the directory + subdirs
 * and writes a fully-commented config.toml template (via buildConfigToml({})).
 * On a fresh install, auto-invokes `system2 config` so the user lands directly
 * in the credential-management menu without needing a second command.
 *
 * Refuses to overwrite an existing install: prints a friendly message pointing
 * at `system2 config` for re-configuration and exits cleanly.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { buildConfigToml, CONFIG_FILE, SYSTEM2_DIR } from '../utils/config.js';
import { config } from './config.js';

export interface InitOptions {
  /** Override the install directory. Tests pass a tmpdir; production omits this. */
  system2Dir?: string;
  /** Override the config.toml path. Defaults to `<system2Dir>/config.toml`. */
  configFile?: string;
  /**
   * Override the post-install hand-off. Defaults to invoking `config()`. Tests
   * pass a spy to assert init wired the chain without actually running the
   * interactive menu.
   */
  invokeConfig?: () => Promise<void>;
}

export async function init(options: InitOptions = {}): Promise<void> {
  const dir = options.system2Dir ?? SYSTEM2_DIR;
  const configPath =
    options.configFile ?? (options.system2Dir ? join(dir, 'config.toml') : CONFIG_FILE);
  const invoke = options.invokeConfig ?? config;

  console.clear();

  if (existsSync(dir)) {
    p.intro('🧠 Welcome back to System2!');
    p.log.info(
      `Found existing installation at ${dir}.\n\n` +
        `To manage credentials, run:\n  > ${pc.bold('system2 config')}\n\n` +
        `To start fresh (this will reset System2, losing memory of all previous work):\n` +
        `  > ${pc.bold(`mv ${dir} ${dir}.backup`)}\n` +
        `  > ${pc.bold('system2 init')}`
    );
    return;
  }

  p.intro('🧠 Welcome to System2, the AI multi-agent system for working with data.');

  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, 'sessions'), { recursive: true });
  await mkdir(join(dir, 'projects'), { recursive: true });
  await mkdir(join(dir, 'artifacts'), { recursive: true });

  await writeFile(configPath, buildConfigToml({}), { mode: 0o600 });

  p.log.info(`✓ Created ${dir}/ with a templated config.toml.`);
  p.log.info(
    'You need at least one LLM credential before System2 can run.\nLaunching configuration...'
  );

  await invoke();
}
