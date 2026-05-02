import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir as mkdirAsync } from 'node:fs/promises';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import TOML from '@iarna/toml';
import open from 'open';
import pc from 'picocolors';
import { loginProvider } from '../../server/agents/oauth.js';
import { saveOAuthCredentials } from '../../server/agents/oauth-credentials.js';
import type { LlmProvider } from '../../shared/index.js';
import { CONFIG_FILE, SYSTEM2_DIR } from '../utils/config.js';

/**
 * Format the message shown when an OAuth provider needs browser auth.
 * Some providers (Anthropic, Codex) use a localhost callback flow and only
 * supply `url`; others (GitHub Copilot) use the device flow and supply an
 * `instructions` string with the user code that must be entered manually.
 * Returning a single formatted string lets login/onboard share the wording
 * and gives us a small testable surface for "don't drop the device code".
 */
export function formatOAuthAuthMessage(url: string, instructions?: string): string {
  const detail = instructions ? `\n${instructions}` : '';
  return `Open this URL to authenticate (browser should open automatically):\n${url}${detail}`;
}

function isDaemonRunning(): boolean {
  const pidFile = join(SYSTEM2_DIR, 'server.pid');
  if (!existsSync(pidFile)) return false;
  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

const OAUTH_PROVIDERS: { value: LlmProvider; label: string; hint: string }[] = [
  {
    value: 'anthropic',
    label: 'Anthropic (Claude Pro/Max)',
    hint: 'Uses your Claude.ai subscription.',
  },
  {
    value: 'openai-codex',
    label: 'OpenAI Codex (ChatGPT)',
    hint: 'Uses your ChatGPT account.',
  },
  {
    value: 'github-copilot',
    label: 'GitHub Copilot',
    hint: 'Uses your GitHub Copilot subscription.',
  },
];

/**
 * Patch config.toml to include `provider` in the OAuth tier (`[llm.oauth]`).
 * If the section is missing, create it with `provider` as primary and empty fallback.
 * If present with a different primary, append `provider` to fallback.
 * If `provider` is already in the tier, no-op.
 *
 * Returns { changed: boolean }.
 */
export function addProviderToOAuthTier(
  configPath: string,
  provider: LlmProvider
): { changed: boolean } {
  if (!existsSync(configPath)) {
    throw new Error(`config.toml not found at ${configPath}`);
  }
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = TOML.parse(raw) as { llm?: { oauth?: { primary?: string; fallback?: string[] } } };
  const oauth = parsed.llm?.oauth;

  if (!oauth) {
    const insertion = `[llm.oauth]\nprimary = "${provider}"\nfallback = []\n`;
    const lines = raw.split('\n');
    const llmHeaderIdx = lines.findIndex((l) => l.trim() === '[llm]');
    if (llmHeaderIdx === -1) {
      // No [llm] block. Append at end (preserve trailing newline behavior).
      const sep = raw.endsWith('\n') ? '' : '\n';
      writeFileSync(configPath, `${raw}${sep}\n${insertion}`);
      return { changed: true };
    }
    // Find end of [llm] block: next line that starts a new table, or EOF
    let insertIdx = lines.length;
    for (let i = llmHeaderIdx + 1; i < lines.length; i++) {
      if (/^\[/.test(lines[i].trim())) {
        insertIdx = i;
        break;
      }
    }
    // Skip any blank lines immediately before the next section so we insert *before* the blank line
    while (insertIdx > llmHeaderIdx + 1 && lines[insertIdx - 1].trim() === '') {
      insertIdx--;
    }
    lines.splice(insertIdx, 0, '', `[llm.oauth]`, `primary = "${provider}"`, 'fallback = []');
    writeFileSync(configPath, lines.join('\n'));
    return { changed: true };
  }

  const inTier = oauth.primary === provider || (oauth.fallback ?? []).includes(provider);
  if (inTier) return { changed: false };

  // Append to fallback array. Capture ONLY the [llm.oauth] header + its
  // immediate key=value lines, stopping at the first blank line, comment,
  // or next `[`-section. A wider span would include intervening commented
  // templates and section dividers (which buildConfigToml emits between
  // tiers); replacing that span destroys structure. See OAUTH_BLOCK_PATTERN.
  const match = raw.match(OAUTH_BLOCK_PATTERN);
  if (!match) {
    // TOML.parse found [llm.oauth] but the regex doesn't match — likely an
    // unusual on-disk format (leading whitespace before the header, key on
    // same line as header, etc.). Throw rather than silently no-op: the
    // credential file has already been written, so a silent miss here would
    // leave the user logged in but not registered in [llm.oauth]. Matches
    // the failure mode of removeProviderFromOAuthTier / setProviderAsPrimary.
    throw new Error(
      `Could not locate [llm.oauth] section in ${configPath} for rewrite. ` +
        `Edit the file manually if it has unusual formatting.`
    );
  }
  const newFallback = [...(oauth.fallback ?? []), provider];
  const fallbackLine = `fallback = [${newFallback.map((f) => `"${f}"`).join(', ')}]`;
  const replacedSection = match[0].replace(/fallback\s*=\s*\[[^\]]*\]/, fallbackLine);

  // If regex didn't match an existing fallback line, the section is unchanged.
  // We need to insert the fallback line after the primary line instead.
  if (replacedSection === match[0]) {
    const withFallback = match[0].replace(/(primary\s*=\s*"[^"]*"\s*\n)/, `$1${fallbackLine}\n`);
    if (withFallback === match[0]) {
      // No primary= line either — same partial-success risk as a regex miss.
      throw new Error(
        `Could not locate primary= line in [llm.oauth] section of ${configPath} ` +
          `to anchor a fallback insertion. Edit the file manually.`
      );
    }
    writeFileSync(configPath, raw.replace(OAUTH_BLOCK_PATTERN, withFallback));
    return { changed: true };
  }

  writeFileSync(configPath, raw.replace(OAUTH_BLOCK_PATTERN, replacedSection));
  return { changed: true };
}

/**
 * Pattern matching the [llm.oauth] block: header line + immediate key=value
 * lines (typically primary + fallback), stopping at the first blank line,
 * comment line, or next `[`-section header.
 *
 * Prior versions used a wide pattern that ran to the next live `[`-section,
 * which silently consumed everything in between — fine when adjacent
 * sections were always live, but corrupting once buildConfigToml started
 * emitting commented templates and dividers between live sections. The
 * narrow pattern preserves those structural elements (and any
 * `[llm.oauth.<provider>]` sub-section model pins, which sit below a blank
 * line and so are now also preserved).
 */
const OAUTH_BLOCK_PATTERN = /^\[llm\.oauth\][^\n]*\n(?:[^[#\s][^\n]*\n)+/m;

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

  let newPrimary: string | null = oauth.primary ?? null;
  let newFallback = fallback.slice();

  if (isPrimary) {
    newPrimary = newFallback.length > 0 ? (newFallback.shift() ?? null) : null;
  } else {
    newFallback = newFallback.filter((f) => f !== provider);
  }

  if (!OAUTH_BLOCK_PATTERN.test(raw)) {
    // TOML parse found [llm.oauth] but the regex doesn't match — likely an
    // unusual on-disk format (leading whitespace before the header, key on
    // same line as header, etc.). Throw rather than silently no-op while
    // reporting changed=true.
    throw new Error(
      `Could not locate [llm.oauth] section in ${configPath} for rewrite. ` +
        `Edit the file manually if it has unusual formatting.`
    );
  }

  if (newPrimary === null) {
    writeFileSync(configPath, raw.replace(OAUTH_BLOCK_PATTERN, ''));
    return { changed: true };
  }

  const fbStr = newFallback.map((f) => `"${f}"`).join(', ');
  const replacement = `[llm.oauth]\nprimary = "${newPrimary}"\nfallback = [${fbStr}]\n`;
  writeFileSync(configPath, raw.replace(OAUTH_BLOCK_PATTERN, replacement));
  return { changed: true };
}

/**
 * Read the current `[llm.oauth]` tier from config.toml.
 * Returns null if the section is absent.
 */
function readOAuthTier(configPath: string): { primary: string; fallback: string[] } | null {
  if (!existsSync(configPath)) return null;
  const parsed = TOML.parse(readFileSync(configPath, 'utf-8')) as {
    llm?: { oauth?: { primary?: string; fallback?: string[] } };
  };
  const oauth = parsed.llm?.oauth;
  if (!oauth?.primary) return null;
  return { primary: oauth.primary, fallback: oauth.fallback ?? [] };
}

/**
 * Promote `provider` to primary in `[llm.oauth]`. The current primary becomes the
 * head of fallback (preserving the rest of fallback's order). If `provider` is
 * already primary, no-op.
 */
export function setProviderAsPrimary(
  configPath: string,
  provider: LlmProvider
): { changed: boolean } {
  const current = readOAuthTier(configPath);
  if (!current) {
    throw new Error(`[llm.oauth] section not found in ${configPath}`);
  }
  if (current.primary === provider) return { changed: false };

  // Move current primary to head of fallback. Strip provider from fallback if
  // it was there, then prepend the old primary.
  const newFallback = [current.primary, ...current.fallback.filter((f) => f !== provider)];

  const raw = readFileSync(configPath, 'utf-8');
  if (!OAUTH_BLOCK_PATTERN.test(raw)) {
    // TOML parse found [llm.oauth] (readOAuthTier returned non-null) but the
    // regex doesn't match — likely an unusual on-disk format. Throw rather
    // than silently no-op while reporting changed=true.
    throw new Error(
      `Could not locate [llm.oauth] section in ${configPath} for rewrite. ` +
        `Edit the file manually if it has unusual formatting.`
    );
  }
  const fbStr = newFallback.map((f) => `"${f}"`).join(', ');
  const replacement = `[llm.oauth]\nprimary = "${provider}"\nfallback = [${fbStr}]\n`;
  writeFileSync(configPath, raw.replace(OAUTH_BLOCK_PATTERN, replacement));
  return { changed: true };
}

/**
 * Remove a provider's OAuth credentials and deregister it from [llm.oauth].
 * Returns true on success.
 */
async function removeProviderCredentials(provider: LlmProvider): Promise<boolean> {
  const credPath = join(SYSTEM2_DIR, 'oauth', `${provider}.json`);
  if (existsSync(credPath)) {
    rmSync(credPath);
    p.log.info(`✓ Deleted ${credPath}`);
  } else {
    p.log.info(`No credentials file at ${credPath}`);
  }
  const result = removeProviderFromOAuthTier(CONFIG_FILE, provider);
  if (result.changed) {
    p.log.info(`✓ Removed ${provider} from [llm.oauth] in ${CONFIG_FILE}`);
  } else {
    p.log.info(`${provider} was not in [llm.oauth] — no config change`);
  }
  return true;
}

/**
 * One iteration of the login wizard: pick a provider, log in / re-login / remove,
 * optionally promote to primary. Returns 'continue' to keep looping, 'done' to
 * exit (user cancelled).
 */
async function performLoginIteration(): Promise<'continue' | 'done'> {
  const oauthDir = join(SYSTEM2_DIR, 'oauth');
  const initialTier = readOAuthTier(CONFIG_FILE);
  const options = OAUTH_PROVIDERS.map((opt) => {
    const existing = existsSync(join(oauthDir, `${opt.value}.json`));
    const isPrimary = initialTier?.primary === opt.value;
    let suffix = '';
    if (existing && isPrimary) suffix = '  ✓ logged in (primary)';
    else if (existing) suffix = '  ✓ logged in';
    return {
      value: opt.value,
      label: `${opt.label}${suffix}`,
      hint: opt.hint,
    };
  });

  const target = (await p.select({
    message: 'Select OAuth provider:',
    options,
  })) as LlmProvider;

  if (p.isCancel(target)) return 'done';

  // Already-logged-in path: re-login, promote to primary, remove, or cancel.
  const isAlreadyLoggedIn = existsSync(join(oauthDir, `${target}.json`));
  if (isAlreadyLoggedIn) {
    const tierBefore = readOAuthTier(CONFIG_FILE);
    // Only offer "promote" when [llm.oauth] exists and target isn't already primary.
    // setProviderAsPrimary throws when the section is absent (legitimate edge case if
    // the user deleted [llm.oauth] manually but kept the JSON credential file), so
    // hiding the option prevents an unrecoverable error from the menu.
    const canPromote = tierBefore !== null && tierBefore.primary !== target;

    const action = (await p.select({
      message: `Already logged in to ${target}. What now?`,
      options: [
        { value: 'relogin', label: 'Re-login (replace credentials)' },
        ...(canPromote ? [{ value: 'promote', label: 'Set as primary OAuth provider' }] : []),
        { value: 'remove', label: 'Remove (delete credentials and remove from [llm.oauth])' },
        { value: 'cancel', label: 'Cancel' },
      ],
    })) as 'relogin' | 'promote' | 'remove' | 'cancel';
    if (p.isCancel(action) || action === 'cancel') return 'continue';
    if (action === 'remove') {
      // Explicit confirmation: a single misclick on the menu shouldn't delete a
      // valid credential plus mutate config.toml.
      const confirmed = await p.confirm({
        message: `Delete credentials for ${target} and remove it from [llm.oauth]?`,
        initialValue: false,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        p.log.info('Removal cancelled');
        return 'continue';
      }
      await removeProviderCredentials(target);
      return 'continue';
    }
    if (action === 'promote') {
      const r = setProviderAsPrimary(CONFIG_FILE, target);
      if (r.changed) {
        p.log.info(`✓ Set ${target} as primary OAuth provider in ${CONFIG_FILE}`);
      } else {
        p.log.info(`${target} was already primary — no changes`);
      }
      return 'continue';
    }
    // 'relogin' falls through to the standard login path below.
  }

  const defaultLabel = target;
  const label = (await p.text({
    message: 'Label for this OAuth credential:',
    placeholder: defaultLabel,
    defaultValue: defaultLabel,
  })) as string;
  if (p.isCancel(label)) return 'continue';

  if (!existsSync(SYSTEM2_DIR)) {
    await mkdirAsync(SYSTEM2_DIR, { recursive: true });
  }

  const s = p.spinner();
  s.start('Waiting for browser authentication...');
  try {
    const creds = await loginProvider(target, {
      onAuth: ({ url, instructions }) => {
        // Stop, print the URL persistently, attempt to open the browser, then
        // restart the spinner. s.message() would be overwritten on the next
        // onProgress; p.log.info() under an active spinner is suppressed.
        // Stop+log+restart guarantees the URL/code stay visible. open() is
        // best-effort: if it fails (no browser, headless env, etc.), the user
        // can still copy the URL above the spinner.
        s.stop('Browser authentication required:');
        p.log.info(formatOAuthAuthMessage(url, instructions));
        void open(url).catch(() => {
          // Browser open failed — URL is already printed; user copies manually.
        });
        s.start('Waiting for OAuth callback...');
      },
      onPrompt: async ({ message, placeholder }) => {
        s.stop('Browser callback timed out');
        const value = (await p.text({ message, placeholder })) as string;
        if (p.isCancel(value)) {
          // Throw rather than return ''. Pi-ai would otherwise try to exchange the
          // empty string as the auth code and produce a confusing error. The throw
          // is caught by the surrounding try, which logs the failure and returns
          // 'continue' so the wizard loop advances cleanly.
          throw new Error('Cancelled by user');
        }
        s.start('Exchanging code...');
        return value;
      },
      onProgress: (m) => s.message(m),
    });
    // Spread preserves provider-specific extras (e.g. Copilot's enterpriseDomain).
    saveOAuthCredentials(SYSTEM2_DIR, target, {
      ...creds,
      label: label || defaultLabel,
    });
    s.stop('✓ OAuth login successful');
  } catch (err) {
    s.stop('✗ OAuth login failed');
    p.log.error(err instanceof Error ? err.message : String(err));
    return 'continue';
  }

  // Auto-patch config.toml. The credential is useless until [llm.oauth] references it.
  const patchResult = addProviderToOAuthTier(CONFIG_FILE, target);
  if (patchResult.changed) {
    p.log.info(`✓ Updated [llm.oauth] in ${CONFIG_FILE}`);
  }

  // Offer to promote to primary, but only when there's an existing different primary.
  // (If the patch just made target the primary, or it was already primary, skip.)
  const tier = readOAuthTier(CONFIG_FILE);
  if (tier && tier.primary !== target) {
    const promote = (await p.select({
      message: 'OAuth tier order:',
      options: [
        {
          value: 'keep',
          label: `Keep ${tier.primary} as primary, ${target} as fallback`,
        },
        {
          value: 'promote',
          label: `Make ${target} primary, move ${tier.primary} to fallback`,
        },
      ],
      initialValue: 'keep',
    })) as 'keep' | 'promote';
    if (!p.isCancel(promote) && promote === 'promote') {
      const r = setProviderAsPrimary(CONFIG_FILE, target);
      if (r.changed) p.log.info(`✓ Set ${target} as primary OAuth provider`);
    }
  }

  return 'continue';
}

export async function login(): Promise<void> {
  console.clear();

  if (!existsSync(CONFIG_FILE)) {
    p.intro('🧠 System2 OAuth login');
    p.cancel(`No System2 installation found at ${SYSTEM2_DIR}. Run "system2 onboard" first.`);
    process.exit(1);
  }

  if (isDaemonRunning()) {
    p.intro('🧠 System2 OAuth login');
    p.cancel('System2 daemon is running. Stop it first with: system2 stop');
    process.exit(1);
  }

  p.intro('🧠 System2 OAuth login');

  // Wizard loop: each iteration manages one provider; user chooses whether to
  // continue managing more.
  while (true) {
    const result = await performLoginIteration();
    if (result === 'done') break;

    const another = await p.confirm({
      message: 'Manage another OAuth provider?',
      initialValue: false,
    });
    if (p.isCancel(another) || !another) break;
  }

  p.outro(
    `✨ Done. If system2 is running, restart to apply: ${pc.bold('system2 stop && system2 start')}`
  );

  // Pi-ai's gemini-cli/antigravity OAuth flows leave the local callback server's
  // idle keep-alive connections open after server.close(). Node ≥18 keeps the event
  // loop alive until those connections time out (~5 min), so the CLI appears to hang
  // after a successful login. Explicit exit since this is a one-shot command.
  process.exit(0);
}
