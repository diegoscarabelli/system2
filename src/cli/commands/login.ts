import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir as mkdirAsync } from 'node:fs/promises';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import open from 'open';
import pc from 'picocolors';
import { loginProvider } from '../../server/agents/oauth.js';
import { saveOAuthCredentials } from '../../server/agents/oauth-credentials.js';
import type { LlmProvider } from '../../shared/index.js';
import { CONFIG_FILE, SYSTEM2_DIR } from '../utils/config.js';
import { formatOAuthAuthMessage } from '../utils/oauth-format.js';
import {
  addProviderToOAuthTier,
  readOAuthTier,
  removeProviderFromOAuthTier,
  setProviderAsPrimary,
} from '../utils/toml-patchers.js';

// Re-export so existing tests in login.test.ts keep working until Task 14
// deletes login.ts entirely.
export {
  addProviderToOAuthTier,
  removeProviderFromOAuthTier,
  setProviderAsPrimary,
} from '../utils/toml-patchers.js';
export { formatOAuthAuthMessage } from '../utils/oauth-format.js';

// formatOAuthAuthMessage moved to ../utils/oauth-format.ts (re-exported below).

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
