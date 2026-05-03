/**
 * Init Command
 *
 * Scaffolds ~/.system2/ on a fresh install: creates the directory + subdirs
 * (including auth/ at 0o700) and writes a fully-commented config.toml template
 * (via buildConfigToml({})). The auth.toml file is NOT created here — it's
 * created by `system2 config` on first credential write.
 *
 * On a fresh install, auto-invokes `system2 config` so the user lands directly
 * in the credential-management menu without needing a second command.
 *
 * Refuses to overwrite an existing config.toml: prints a friendly message
 * pointing at `system2 config` for re-configuration and exits cleanly. The
 * auth/ directory and any auth.toml inside are left alone in all paths.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { ensureAuthDir } from '../utils/auth-config.js';
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

  // Gate on configPath (the install marker), not the directory itself.
  // Without this, a stray `~/.system2/` directory (e.g. left behind after a
  // partial uninstall, or pre-created by another tool) would lock the user
  // out: `system2 init` would refuse to write the template, and the missing
  // config.toml would also block `system2 config` and `system2 start`. This
  // lets `init` recover by writing the template into an existing-but-empty
  // directory.
  if (existsSync(configPath)) {
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

  // mkdir is recursive + idempotent, so all of these work whether the
  // directory already exists (config.toml-less recovery case) or is brand new.
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, 'sessions'), { recursive: true });
  await mkdir(join(dir, 'projects'), { recursive: true });
  await mkdir(join(dir, 'artifacts'), { recursive: true });
  // auth/ dir holds OAuth credential JSONs and (once `system2 config` writes
  // the first credential) auth.toml. ensureAuthDir creates it if missing AND
  // chmods to 0o700 if it already exists with looser perms (defends against
  // a stray `~/.system2/auth/` left at 0o755 from an interrupted install or
  // hand-modification).
  ensureAuthDir(dir);

  await writeFile(configPath, buildConfigToml({}), { mode: 0o600 });

  p.log.info(`✓ Created ${dir}/ with a templated config.toml and an empty auth/ dir.`);
  p.log.info(
    'You need at least one LLM credential before System2 can run.\nLaunching configuration...'
  );

  await invoke();
}
