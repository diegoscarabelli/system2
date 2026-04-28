import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import TOML from '@iarna/toml';
import pc from 'picocolors';
import type { LlmProvider } from '../../shared/index.js';
import { CONFIG_FILE, SYSTEM2_DIR } from '../utils/config.js';

const OAUTH_PROVIDERS: LlmProvider[] = ['anthropic'];

/**
 * Patch config.toml to remove `provider` from `[llm.oauth]`.
 * - If `provider` is the primary and there's a fallback: promote the first fallback to primary.
 * - If `provider` is the primary and no fallback: drop the `[llm.oauth]` section entirely.
 * - If `provider` is in fallback: remove it from the fallback list.
 * - If `provider` not in the tier: no-op.
 */
export function removeProviderFromOAuthTier(
  configPath: string,
  provider: LlmProvider
): { changed: boolean } {
  if (!existsSync(configPath)) {
    throw new Error(`config.toml not found at ${configPath}`);
  }
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = TOML.parse(raw) as { llm?: { oauth?: { primary?: string; fallback?: string[] } } };
  const oauth = parsed.llm?.oauth;
  if (!oauth) return { changed: false };

  const fallback = oauth.fallback ?? [];
  const isPrimary = oauth.primary === provider;
  const inFallback = fallback.includes(provider);
  if (!isPrimary && !inFallback) return { changed: false };

  // Compute the new shape
  let newPrimary: string | null = oauth.primary ?? null;
  let newFallback = fallback.slice();

  if (isPrimary) {
    if (newFallback.length > 0) {
      newPrimary = newFallback.shift() ?? null;
    } else {
      newPrimary = null;
    }
  } else {
    newFallback = newFallback.filter((f) => f !== provider);
  }

  const sectionPattern = /\n?\[llm\.oauth\][\s\S]*?(?=\n\[|$)/;

  if (newPrimary === null) {
    // Drop the entire section
    writeFileSync(configPath, raw.replace(sectionPattern, ''));
    return { changed: true };
  }

  const fbStr = newFallback.map((f) => `"${f}"`).join(', ');
  const replacement = `\n[llm.oauth]\nprimary = "${newPrimary}"\nfallback = [${fbStr}]\n`;
  writeFileSync(configPath, raw.replace(sectionPattern, replacement));
  return { changed: true };
}

export async function logout(provider?: string): Promise<void> {
  console.clear();
  p.intro('🧠 System2 OAuth logout');

  if (!existsSync(CONFIG_FILE)) {
    p.cancel(`No System2 installation found at ${SYSTEM2_DIR}.`);
    process.exit(1);
  }

  let target: LlmProvider;
  if (provider) {
    if (!OAUTH_PROVIDERS.includes(provider as LlmProvider)) {
      p.cancel(
        `OAuth logout for "${provider}" is not supported. Supported: ${OAUTH_PROVIDERS.join(', ')}`
      );
      process.exit(1);
    }
    target = provider as LlmProvider;
  } else {
    target = OAUTH_PROVIDERS[0];
  }

  const credPath = join(SYSTEM2_DIR, 'oauth', `${target}.json`);
  const fileExists = existsSync(credPath);

  if (!fileExists) {
    p.log.info(`No credentials file found at ${credPath}`);
  } else {
    const confirmDelete = await p.confirm({
      message: `Delete OAuth credentials for ${target} (${credPath})?`,
      initialValue: true,
    });
    if (p.isCancel(confirmDelete) || !confirmDelete) {
      p.cancel('Cancelled');
      process.exit(0);
    }
    rmSync(credPath);
    p.log.info(`✓ Deleted ${credPath}`);
  }

  const confirmConfig = await p.confirm({
    message: `Remove ${target} from [llm.oauth] in config.toml?`,
    initialValue: true,
  });
  if (p.isCancel(confirmConfig)) {
    p.cancel('Cancelled');
    process.exit(0);
  }
  if (confirmConfig) {
    const result = removeProviderFromOAuthTier(CONFIG_FILE, target);
    if (result.changed) {
      p.log.info(`✓ Updated [llm.oauth] in ${CONFIG_FILE}`);
    } else {
      p.log.info(`${target} was not in [llm.oauth] — no changes`);
    }
  }

  p.outro(
    `Done. If system2 is running, restart to apply: ${pc.bold('system2 stop && system2 start')}`
  );
}
