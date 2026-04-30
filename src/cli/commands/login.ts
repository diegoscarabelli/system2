import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir as mkdirAsync } from 'node:fs/promises';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import TOML from '@iarna/toml';
import pc from 'picocolors';
import { loginProvider } from '../../server/agents/oauth.js';
import { saveOAuthCredentials } from '../../server/agents/oauth-credentials.js';
import type { LlmProvider } from '../../shared/index.js';
import { CONFIG_FILE, SYSTEM2_DIR } from '../utils/config.js';

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
    label: 'OpenAI Codex (ChatGPT Plus/Pro)',
    hint: 'Uses your ChatGPT subscription. Codex models only.',
  },
  {
    value: 'google-gemini-cli',
    label: 'Google Gemini CLI (Gemini subscription)',
    hint: 'Uses your Google account / Gemini subscription.',
  },
  {
    value: 'google-antigravity',
    label: 'Google Antigravity',
    hint: 'Uses your Google account via Antigravity. Access to Gemini 3, Claude, GPT-OSS.',
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

  // Append to fallback array. Reconstruct the section in-place via regex on the existing section.
  const sectionPattern = /\[llm\.oauth\]([\s\S]*?)(?=\n\[|$)/;
  const match = raw.match(sectionPattern);
  if (!match) {
    // Shouldn't happen because oauth is non-null, but guard anyway
    return { changed: false };
  }
  const newFallback = [...(oauth.fallback ?? []), provider];
  const fallbackLine = `fallback = [${newFallback.map((f) => `"${f}"`).join(', ')}]`;
  const replacedSection = match[0].replace(/fallback\s*=\s*\[[^\]]*\]/, fallbackLine);

  // If regex didn't match an existing fallback line, the section is unchanged.
  // We need to insert the fallback line after the primary line instead.
  if (replacedSection === match[0]) {
    const withFallback = match[0].replace(/(primary\s*=\s*"[^"]*"\s*\n)/, `$1${fallbackLine}\n`);
    if (withFallback === match[0]) {
      // Could not even find a primary= line — bail.
      return { changed: false };
    }
    writeFileSync(configPath, raw.replace(sectionPattern, withFallback));
    return { changed: true };
  }

  writeFileSync(configPath, raw.replace(sectionPattern, replacedSection));
  return { changed: true };
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

  // Annotate already-logged-in providers with "(replace)" so the user knows re-login overwrites.
  const oauthDir = join(SYSTEM2_DIR, 'oauth');
  const options = OAUTH_PROVIDERS.map((opt) => {
    const existing = existsSync(join(oauthDir, `${opt.value}.json`));
    return {
      value: opt.value,
      label: existing ? `${opt.label}  ✓ already logged in (replace)` : opt.label,
      hint: opt.hint,
    };
  });

  const target = (await p.select({
    message: 'Select OAuth provider to log in to:',
    options,
  })) as LlmProvider;

  if (p.isCancel(target)) {
    p.cancel('Cancelled');
    process.exit(0);
  }

  const defaultLabel = target;
  const label = (await p.text({
    message: 'Label for this OAuth credential:',
    placeholder: defaultLabel,
    defaultValue: defaultLabel,
  })) as string;
  if (p.isCancel(label)) {
    p.cancel('Cancelled');
    process.exit(0);
  }

  if (!existsSync(SYSTEM2_DIR)) {
    await mkdirAsync(SYSTEM2_DIR, { recursive: true });
  }

  const s = p.spinner();
  s.start('Waiting for browser authentication...');
  try {
    const creds = await loginProvider(target, {
      onAuth: ({ url }) => {
        s.message(`Open this URL to authenticate:\n${url}`);
      },
      onPrompt: async ({ message, placeholder }) => {
        s.stop('Browser callback timed out');
        const value = (await p.text({ message, placeholder })) as string;
        if (p.isCancel(value)) {
          p.cancel('Cancelled');
          process.exit(0);
        }
        s.start('Exchanging code...');
        return value;
      },
      onProgress: (m) => s.message(m),
    });
    // Spread preserves provider-specific extras (projectId, email, enterpriseDomain).
    saveOAuthCredentials(SYSTEM2_DIR, target, {
      ...creds,
      label: label || defaultLabel,
    });
    s.stop('✓ OAuth login successful');
  } catch (err) {
    s.stop('✗ OAuth login failed');
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Auto-patch config.toml. The credential is useless until [llm.oauth] references it,
  // so there's no scenario where the user would want to skip this.
  const result = addProviderToOAuthTier(CONFIG_FILE, target);
  if (result.changed) {
    p.log.info(`✓ Updated [llm.oauth] in ${CONFIG_FILE}`);
  } else {
    p.log.info(`${target} is already in [llm.oauth] — no changes`);
  }

  p.outro(
    `✨ Done. If system2 is running, restart to apply: ${pc.bold('system2 stop && system2 start')}`
  );
}
