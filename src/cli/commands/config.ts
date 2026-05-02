/**
 * Config Command
 *
 * Re-entrant top-level menu for credentials and services. Three submenus:
 *   - OAuth providers (Anthropic, OpenAI Codex, GitHub Copilot)
 *   - API key providers (the existing 9 providers)
 *   - Services (Brave Search; structure leaves room for siblings)
 *
 * Cancel/back semantics:
 *   - Main menu Esc → exit cleanly.
 *   - Submenu Esc / "Back to main menu" → return to main menu.
 *   - Inside any data-entry flow: Esc or empty submission on a required prompt
 *     → return to the enclosing submenu without writing anything. No global
 *     `process.exit(0)` calls inside flows; no infinite "API key is required"
 *     loops.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir as mkdirAsync } from 'node:fs/promises';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import TOML from '@iarna/toml';
import open from 'open';
import pc from 'picocolors';
import { loginProvider } from '../../server/agents/oauth.js';
import { saveOAuthCredentials } from '../../server/agents/oauth-credentials.js';
import type { LlmKey, LlmProvider } from '../../shared/index.js';
import { CONFIG_FILE, SYSTEM2_DIR } from '../utils/config.js';
import { formatOAuthAuthMessage } from '../utils/oauth-format.js';
import {
  addKeyToApiKeyProvider,
  addProviderToApiKeysTier,
  addProviderToOAuthTier,
  escapeTomlString,
  readApiKeysTier,
  readOAuthTier,
  removeBraveSearch,
  removeProviderFromApiKeysTier,
  removeProviderFromOAuthTier,
  replaceKeyInApiKeyProvider,
  setApiKeyProviderAsPrimary,
  setApiKeysFallbackOrder,
  setBraveSearchKey,
  setOAuthFallbackOrder,
  setProviderAsPrimary,
} from '../utils/toml-patchers.js';

export interface ConfigOptions {
  /** Override config.toml path. Tests pass a tmp file; production omits. */
  configFile?: string;
  /** Override ~/.system2 path (oauth/, etc.). */
  system2Dir?: string;
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

const API_KEY_PROVIDERS: { value: LlmProvider; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'cerebras', label: 'Cerebras (fast inference)' },
  { value: 'google', label: 'Google (Gemini)' },
  { value: 'groq', label: 'Groq (fast inference)' },
  { value: 'mistral', label: 'Mistral (Mistral & Magistral)' },
  { value: 'openai', label: 'OpenAI (GPT & o-series)' },
  { value: 'openai-compatible', label: 'OpenAI-compatible (LiteLLM, vLLM, Ollama, ...)' },
  { value: 'openrouter', label: 'OpenRouter (multi-provider gateway)' },
  { value: 'xai', label: 'xAI (Grok)' },
];

function isDaemonRunning(system2Dir: string): boolean {
  const pidFile = join(system2Dir, 'server.pid');
  if (!existsSync(pidFile)) return false;
  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function config(options: ConfigOptions = {}): Promise<void> {
  const configPath = options.configFile ?? CONFIG_FILE;
  const system2Dir = options.system2Dir ?? SYSTEM2_DIR;

  if (!existsSync(configPath)) {
    p.intro('🧠 System2 configuration');
    p.cancel(`No System2 installation found at ${system2Dir}. Run "system2 init" first.`);
    process.exit(1);
  }

  if (isDaemonRunning(system2Dir)) {
    p.intro('🧠 System2 configuration');
    p.cancel('System2 daemon is running. Stop it first with: system2 stop');
    process.exit(1);
  }

  // Upfront TOML validation: surface a clean parse error and exit, rather than
  // letting any of the submenus / patchers / read* helpers crash mid-flow with
  // a stack trace. Submenus all do their own TOML.parse calls; if any of them
  // would fail, we'd rather catch it here at a single guarded entry point.
  try {
    TOML.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    p.intro('🧠 System2 configuration');
    p.cancel(
      `config.toml could not be parsed:\n  ${err instanceof Error ? err.message : String(err)}\n\n` +
        'Fix the syntax error manually before running system2 config.'
    );
    process.exit(1);
  }

  p.intro('🧠 System2 configuration');

  while (true) {
    const choice = (await p.select({
      message: 'What do you want to configure?',
      options: [
        {
          value: 'oauth',
          label: 'OAuth providers',
          hint: 'Anthropic, OpenAI Codex, GitHub Copilot',
        },
        {
          value: 'api_keys',
          label: 'API key providers',
          hint: 'Anthropic, OpenAI, Google, ...',
        },
        { value: 'services', label: 'Services', hint: 'Brave Search' },
        { value: 'done', label: 'Done' },
      ],
    })) as 'oauth' | 'api_keys' | 'services' | 'done';

    if (p.isCancel(choice) || choice === 'done') break;

    if (choice === 'oauth') await oauthSubmenu(configPath, system2Dir);
    else if (choice === 'api_keys') await apiKeysSubmenu(configPath);
    else await servicesSubmenu(configPath);
  }

  p.outro(
    `✨ Done. If system2 is running, restart to apply: ${pc.bold('system2 stop && system2 start')}`
  );

  // Pi-ai's OAuth callback servers leave idle keep-alive connections open after
  // server.close(). Node keeps the event loop alive until they time out (~5 min),
  // so the CLI appears to hang. Explicit exit since this is a one-shot command.
  process.exit(0);
}

// ─── OAuth submenu ────────────────────────────────────────────────────────────

async function oauthSubmenu(configPath: string, system2Dir: string): Promise<void> {
  const oauthDir = join(system2Dir, 'oauth');

  while (true) {
    const tier = readOAuthTier(configPath);
    const showReorder = tier !== null && tier.fallback.length >= 2;

    const opts: Array<{ value: string; label: string; hint?: string }> = OAUTH_PROVIDERS.map(
      (opt) => {
        const existing = existsSync(join(oauthDir, `${opt.value}.json`));
        const isPrimary = tier?.primary === opt.value;
        const fbIndex = tier?.fallback.indexOf(opt.value) ?? -1;
        let suffix = '';
        if (existing && isPrimary) suffix = '  ✓ logged in (primary)';
        else if (existing && fbIndex >= 0) suffix = `  #${fbIndex + 2} ✓ logged in`;
        else if (existing) suffix = '  ✓ logged in';
        return { value: opt.value, label: `${opt.label}${suffix}`, hint: opt.hint };
      }
    );

    if (showReorder) {
      opts.push({ value: '__reorder__', label: '─── Reorder fallbacks ───' });
    }
    opts.push({ value: '__back__', label: '─── Back to main menu ───' });

    const target = (await p.select({ message: 'Select OAuth provider:', options: opts })) as
      | string
      | symbol;

    if (p.isCancel(target) || target === '__back__') return;
    if (target === '__reorder__') {
      await reorderOAuthFallbacks(configPath);
      continue;
    }

    await handleOAuthProvider(configPath, system2Dir, target as LlmProvider);
  }
}

async function handleOAuthProvider(
  configPath: string,
  system2Dir: string,
  target: LlmProvider
): Promise<void> {
  const oauthDir = join(system2Dir, 'oauth');
  const isAlreadyLoggedIn = existsSync(join(oauthDir, `${target}.json`));

  if (isAlreadyLoggedIn) {
    const tierBefore = readOAuthTier(configPath);
    const canPromote = tierBefore !== null && tierBefore.primary !== target;
    const action = (await p.select({
      message: `Already logged in to ${target}. What now?`,
      options: [
        { value: 'relogin', label: 'Re-login (replace credentials)' },
        ...(canPromote ? [{ value: 'promote', label: 'Set as primary OAuth provider' }] : []),
        {
          value: 'remove',
          label: 'Remove (delete credentials and remove from [llm.oauth])',
        },
        { value: 'cancel', label: 'Cancel' },
      ],
    })) as 'relogin' | 'promote' | 'remove' | 'cancel' | symbol;
    if (p.isCancel(action) || action === 'cancel') return;
    if (action === 'remove') {
      const confirmed = await p.confirm({
        message: `Delete credentials for ${target} and remove it from [llm.oauth]?`,
        initialValue: false,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        p.log.info('Removal cancelled');
        return;
      }
      await removeOAuthProviderCredentials(configPath, system2Dir, target);
      return;
    }
    if (action === 'promote') {
      const r = setProviderAsPrimary(configPath, target);
      if (r.changed) p.log.info(`✓ Set ${target} as primary OAuth provider`);
      else p.log.info(`${target} was already primary — no changes`);
      return;
    }
    // 'relogin' falls through to the standard login flow below.
  }

  // OAuth credentials no longer have per-credential labels (one-per-provider
  // on disk). Skip the label prompt entirely; the provider id alone identifies
  // the credential everywhere it's referenced.
  if (!existsSync(system2Dir)) {
    await mkdirAsync(system2Dir, { recursive: true });
  }

  const s = p.spinner();
  s.start('Waiting for browser authentication...');
  try {
    const creds = await loginProvider(target, {
      onAuth: ({ url, instructions }) => {
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
          throw new Error('Cancelled by user');
        }
        s.start('Exchanging code...');
        return value;
      },
      onProgress: (m) => s.message(m),
    });
    saveOAuthCredentials(system2Dir, target, creds);
    s.stop('✓ OAuth login successful');
  } catch (err) {
    s.stop('✗ OAuth login failed');
    p.log.error(err instanceof Error ? err.message : String(err));
    return;
  }

  // Auto-patch config.toml. The credential is useless until [llm.oauth] references it.
  const patchResult = addProviderToOAuthTier(configPath, target);
  if (patchResult.changed) {
    p.log.info(`✓ Updated [llm.oauth] in ${configPath}`);
  }

  // Offer to promote, only when there's an existing different primary.
  const tier = readOAuthTier(configPath);
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
    })) as 'keep' | 'promote' | symbol;
    if (!p.isCancel(promote) && promote === 'promote') {
      const r = setProviderAsPrimary(configPath, target);
      if (r.changed) p.log.info(`✓ Set ${target} as primary OAuth provider`);
    }
  }
}

async function removeOAuthProviderCredentials(
  configPath: string,
  system2Dir: string,
  provider: LlmProvider
): Promise<void> {
  const credPath = join(system2Dir, 'oauth', `${provider}.json`);
  if (existsSync(credPath)) {
    rmSync(credPath);
    p.log.info(`✓ Deleted ${credPath}`);
  } else {
    p.log.info(`No credentials file at ${credPath}`);
  }
  const result = removeProviderFromOAuthTier(configPath, provider);
  if (result.changed) {
    p.log.info(`✓ Removed ${provider} from [llm.oauth] in ${configPath}`);
  } else {
    p.log.info(`${provider} was not in [llm.oauth] — no config change`);
  }
}

// ─── API keys submenu ─────────────────────────────────────────────────────────

async function apiKeysSubmenu(configPath: string): Promise<void> {
  while (true) {
    const tier = readApiKeysTier(configPath);
    const showReorder = tier !== null && tier.fallback.length >= 2;

    const opts: Array<{ value: string; label: string }> = API_KEY_PROVIDERS.map((opt) => {
      const isPrimary = tier?.primary === opt.value;
      const inProviders = tier?.providers.has(opt.value) ?? false;
      const fbIndex = tier?.fallback.indexOf(opt.value) ?? -1;
      let suffix = '';
      if (isPrimary) suffix = '  ✓ configured (primary)';
      else if (fbIndex >= 0) suffix = `  #${fbIndex + 2} ✓ configured`;
      else if (inProviders) suffix = '  ✓ configured';
      return { value: opt.value, label: `${opt.label}${suffix}` };
    });

    if (showReorder) {
      opts.push({ value: '__reorder__', label: '─── Reorder fallbacks ───' });
    }
    opts.push({ value: '__back__', label: '─── Back to main menu ───' });

    const target = (await p.select({ message: 'Select API key provider:', options: opts })) as
      | string
      | symbol;

    if (p.isCancel(target) || target === '__back__') return;
    if (target === '__reorder__') {
      await reorderApiKeysFallbacks(configPath);
      continue;
    }

    await handleApiKeyProvider(configPath, target as LlmProvider);
  }
}

async function handleApiKeyProvider(configPath: string, target: LlmProvider): Promise<void> {
  const tier = readApiKeysTier(configPath);
  const isConfigured = tier?.providers.has(target) ?? false;

  if (!isConfigured) {
    await addNewApiKeyProvider(configPath, target);
    return;
  }

  const action = (await p.select({
    message: `${labelFor(target)} already configured. What now?`,
    options: [
      { value: 'add', label: 'Add another key' },
      { value: 'replace', label: 'Replace key (overwrite a labeled key)' },
      { value: 'primary', label: 'Set as primary' },
      {
        value: 'remove',
        label: 'Remove provider (delete keys + drop from [llm.api_keys])',
      },
      { value: 'cancel', label: 'Cancel' },
    ],
  })) as 'add' | 'replace' | 'primary' | 'remove' | 'cancel' | symbol;
  if (p.isCancel(action) || action === 'cancel') return;

  if (action === 'add') {
    const k = await promptForKeyAndLabel(target);
    if (!k) return;
    try {
      addKeyToApiKeyProvider(configPath, target, k);
      p.log.info(`✓ Added key "${k.label}" to ${target}`);
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
    }
    return;
  }

  if (action === 'replace') {
    const existingKeys = readApiKeyProviderKeys(configPath, target);
    if (existingKeys.length === 0) return;
    const labelChoice = (await p.select({
      message: 'Which key (by label) do you want to replace?',
      options: existingKeys.map((k) => ({ value: k.label, label: k.label })),
    })) as string | symbol;
    if (p.isCancel(labelChoice)) return;
    const newKeyValue = (await p.password({
      message: `Enter the new key for "${labelChoice}":`,
    })) as string | symbol;
    if (p.isCancel(newKeyValue) || !newKeyValue) return;
    // Replace in place via the dedicated patcher: works whether the provider
    // has 1 key or many, and never mutates [llm.api_keys].primary/.fallback
    // (the previous remove+add dance did, when only one key existed).
    try {
      replaceKeyInApiKeyProvider(configPath, target, labelChoice as string, newKeyValue as string);
      p.log.info(`✓ Replaced key "${labelChoice}" for ${target}`);
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
    }
    return;
  }

  if (action === 'primary') {
    try {
      const r = setApiKeyProviderAsPrimary(configPath, target);
      if (r.changed) p.log.info(`✓ Set ${target} as primary API-key provider`);
      else p.log.info(`${target} was already primary — no changes`);
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
    }
    return;
  }

  if (action === 'remove') {
    const confirmed = await p.confirm({
      message: `Delete all keys for ${target} and remove from [llm.api_keys]?`,
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.log.info('Removal cancelled');
      return;
    }
    const r = removeProviderFromApiKeysTier(configPath, target);
    if (r.changed) p.log.info(`✓ Removed ${target} from [llm.api_keys]`);
  }
}

async function addNewApiKeyProvider(configPath: string, target: LlmProvider): Promise<void> {
  // openai-compatible needs base_url + model + compat_reasoning before the key.
  let extras: { base_url: string; model: string; compat_reasoning: boolean } | undefined;
  if (target === 'openai-compatible') {
    extras = await collectOpenAICompatibleExtras();
    if (!extras) return; // user cancelled
  }

  // Track labels to enforce uniqueness within a single provider's keys array.
  // Later operations (replace/remove by label) would be ambiguous otherwise,
  // and addProviderToApiKeysTier will throw on duplicates anyway — catch them
  // here at collection time so the user can correct the typo without losing
  // the rest of the in-progress entry batch.
  const keys: LlmKey[] = [];
  const seenLabels = new Set<string>();
  const collectUnique = async (firstAttempt: boolean): Promise<LlmKey | null> => {
    while (true) {
      const k = await promptForKeyAndLabel(target);
      if (!k) return null;
      if (seenLabels.has(k.label)) {
        p.log.warn(`Label "${k.label}" already used for ${target}. Pick a different label.`);
        // Loop: re-prompt until the user gives a unique label or cancels.
        // (firstAttempt is informational; same loop semantics either way.)
        void firstAttempt;
        continue;
      }
      return k;
    }
  };
  const first = await collectUnique(true);
  if (!first) return;
  keys.push(first);
  seenLabels.add(first.label);

  while (true) {
    const more = await p.confirm({
      message: `Add another ${labelFor(target)} key?`,
      initialValue: false,
    });
    if (p.isCancel(more) || !more) break;
    const k = await collectUnique(false);
    if (!k) break;
    keys.push(k);
    seenLabels.add(k.label);
  }

  try {
    addProviderToApiKeysTier(configPath, target, keys);
  } catch (err) {
    p.log.error(err instanceof Error ? err.message : String(err));
    return;
  }
  // openai-compatible: append base_url/model/compat_reasoning to the just-created
  // sub-section. If the regex misses, roll back the provider add so the user
  // doesn't end up with a half-configured openai-compatible entry.
  if (extras) {
    try {
      writeOpenAICompatibleExtras(configPath, extras);
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
      try {
        removeProviderFromApiKeysTier(configPath, target);
        p.log.info(`Rolled back partial ${target} configuration`);
      } catch (rollbackErr) {
        p.log.error(
          `Failed to roll back: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`
        );
      }
      return;
    }
  }
  p.log.info(`✓ Added ${target} to [llm.api_keys]`);

  // If a primary already exists, offer to promote.
  const tier = readApiKeysTier(configPath);
  if (tier && tier.primary !== target) {
    const promote = (await p.select({
      message: 'API-key tier order:',
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
    })) as 'keep' | 'promote' | symbol;
    if (!p.isCancel(promote) && promote === 'promote') {
      const r = setApiKeyProviderAsPrimary(configPath, target);
      if (r.changed) p.log.info(`✓ Set ${target} as primary API-key provider`);
    }
  }
}

async function promptForKeyAndLabel(target: LlmProvider): Promise<LlmKey | null> {
  const key = (await p.password({
    message: `Enter your ${labelFor(target)} API key:`,
  })) as string | symbol;
  if (p.isCancel(key) || !key) return null; // empty submission returns to caller
  const label = (await p.text({
    message: 'Label for this key (e.g., "personal", "work"):',
    placeholder: 'default',
    defaultValue: 'default',
  })) as string | symbol;
  if (p.isCancel(label)) return null;
  return { key: key as string, label: (label as string) || 'default' };
}

function readApiKeyProviderKeys(configPath: string, provider: LlmProvider): LlmKey[] {
  const parsed = TOML.parse(readFileSync(configPath, 'utf-8')) as {
    llm?: { api_keys?: Record<string, unknown> };
  };
  const sub = parsed.llm?.api_keys?.[provider] as { keys?: LlmKey[] } | undefined;
  return sub?.keys ?? [];
}

function labelFor(provider: LlmProvider): string {
  return API_KEY_PROVIDERS.find((p) => p.value === provider)?.label ?? provider;
}

async function collectOpenAICompatibleExtras(): Promise<
  { base_url: string; model: string; compat_reasoning: boolean } | undefined
> {
  const baseUrl = (await p.text({
    message: 'Enter the base URL of your OpenAI-compatible endpoint:',
    placeholder: 'http://localhost:4000/v1',
  })) as string | symbol;
  if (p.isCancel(baseUrl) || !baseUrl) return undefined;
  try {
    new URL(baseUrl as string);
  } catch {
    p.log.error('Invalid URL format');
    return undefined;
  }
  const model = (await p.text({
    message: 'Enter the model ID to use:',
    placeholder: 'gpt-4o',
  })) as string | symbol;
  if (p.isCancel(model) || !model) return undefined;
  const reasoning = await p.confirm({
    message: 'Does this model support reasoning/extended thinking?',
    initialValue: true,
  });
  if (p.isCancel(reasoning)) return undefined;
  return {
    base_url: baseUrl as string,
    model: model as string,
    compat_reasoning: reasoning,
  };
}

function writeOpenAICompatibleExtras(
  configPath: string,
  extras: { base_url: string; model: string; compat_reasoning: boolean }
): void {
  const raw = readFileSync(configPath, 'utf-8');
  const pattern = /(\[llm\.api_keys\.openai-compatible\][\s\S]*?keys\s*=\s*\[[\s\S]*?\n\])\n?/;
  // base_url + model are user input; compat_reasoning is a typed boolean so it
  // doesn't need escaping (booleans are bare TOML literals).
  const insertion = `\nbase_url = "${escapeTomlString(extras.base_url)}"\nmodel = "${escapeTomlString(extras.model)}"\ncompat_reasoning = ${extras.compat_reasoning}\n`;
  const match = raw.match(pattern);
  if (!match) {
    // Throw rather than silently return: addProviderToApiKeysTier just wrote
    // the keys; missing extras would leave the user with a partially-configured
    // openai-compatible provider that fails at runtime with a confusing error.
    throw new Error(
      `Could not locate keys array for openai-compatible in ${configPath} ` +
        'to append base_url/model/compat_reasoning.'
    );
  }
  const replacement = `${match[0].replace(/\n?$/, '')}${insertion}`;
  writeFileSync(configPath, raw.replace(pattern, replacement));
}

// ─── Services (Brave Search) submenu ──────────────────────────────────────────

async function servicesSubmenu(configPath: string): Promise<void> {
  while (true) {
    const configured = isBraveSearchConfigured(configPath);
    const choice = (await p.select({
      message: 'Select service:',
      options: [
        {
          value: 'brave',
          label: `Brave Search${configured ? '  ✓ configured' : ''}`,
        },
        { value: '__back__', label: '─── Back to main menu ───' },
      ],
    })) as string | symbol;
    if (p.isCancel(choice) || choice === '__back__') return;
    if (choice === 'brave') await handleBraveSearch(configPath, configured);
  }
}

function isBraveSearchConfigured(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  const parsed = TOML.parse(readFileSync(configPath, 'utf-8')) as {
    services?: { brave_search?: { key?: string } };
  };
  return Boolean(parsed.services?.brave_search?.key);
}

async function handleBraveSearch(configPath: string, configured: boolean): Promise<void> {
  if (!configured) {
    const key = (await p.password({
      message: 'Enter your Brave Search API key:',
    })) as string | symbol;
    if (p.isCancel(key) || !key) return;
    setBraveSearchKey(configPath, key as string);
    p.log.info('✓ Brave Search configured (web search tool enabled)');
    return;
  }
  const action = (await p.select({
    message: 'Brave Search already configured. What now?',
    options: [
      { value: 'replace', label: 'Replace key' },
      { value: 'remove', label: 'Remove' },
      { value: 'cancel', label: 'Cancel' },
    ],
  })) as 'replace' | 'remove' | 'cancel' | symbol;
  if (p.isCancel(action) || action === 'cancel') return;
  if (action === 'replace') {
    const key = (await p.password({
      message: 'Enter new Brave Search API key:',
    })) as string | symbol;
    if (p.isCancel(key) || !key) return;
    setBraveSearchKey(configPath, key as string);
    p.log.info('✓ Brave Search key replaced');
  }
  if (action === 'remove') {
    const confirmed = await p.confirm({
      message: 'Remove Brave Search and disable web search tool?',
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) return;
    removeBraveSearch(configPath);
    p.log.info('✓ Brave Search removed');
  }
}

// ─── Reorder fallbacks (shared by OAuth + API keys) ──────────────────────────

interface ReorderOptions {
  primary: string;
  fallback: string[];
  providerLabel: (id: string) => string;
  commit: (newFallback: string[]) => void;
}

async function reorderFallbacks(opts: ReorderOptions): Promise<void> {
  let order = [...opts.fallback];

  while (true) {
    p.log.info(
      `Primary: ${opts.providerLabel(opts.primary)} (set via "Set as primary" on a provider)\n\n` +
        `Current fallback order:\n` +
        order.map((id, i) => `  ${i + 1}. ${opts.providerLabel(id)}`).join('\n')
    );

    const pick = (await p.select({
      message: 'Pick a fallback to move:',
      options: [
        ...order.map((id) => ({ value: id, label: opts.providerLabel(id) })),
        { value: '__done__', label: '✓ Done' },
      ],
    })) as string | symbol;
    if (p.isCancel(pick) || pick === '__done__') break;

    const idx = order.indexOf(pick as string);
    const move = (await p.select({
      message: `Move ${opts.providerLabel(pick as string)}:`,
      options: [
        { value: 'up', label: 'Move up' },
        { value: 'down', label: 'Move down' },
        { value: 'top', label: 'Move to top' },
        { value: 'bottom', label: 'Move to bottom' },
        { value: 'cancel', label: 'Cancel' },
      ],
    })) as 'up' | 'down' | 'top' | 'bottom' | 'cancel' | symbol;
    if (p.isCancel(move) || move === 'cancel') continue;

    const next = [...order];
    next.splice(idx, 1);
    if (move === 'up') next.splice(Math.max(0, idx - 1), 0, pick as string);
    else if (move === 'down') next.splice(Math.min(next.length, idx + 1), 0, pick as string);
    else if (move === 'top') next.unshift(pick as string);
    else next.push(pick as string);
    order = next;
  }

  const same =
    order.length === opts.fallback.length && order.every((id, i) => id === opts.fallback[i]);
  if (!same) {
    // The toml patcher can throw when the section's on-disk shape is unusual
    // enough that the line-anchored regex can't find it. Surface the error and
    // return cleanly so the user lands back in the submenu instead of crashing
    // the whole `system2 config` session with a raw stack trace.
    try {
      opts.commit(order);
      p.log.info('✓ Fallback order updated');
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
    }
  }
}

async function reorderOAuthFallbacks(configPath: string): Promise<void> {
  const tier = readOAuthTier(configPath);
  if (!tier) return;
  await reorderFallbacks({
    primary: tier.primary,
    fallback: tier.fallback,
    providerLabel: (id) => OAUTH_PROVIDERS.find((opt) => opt.value === id)?.label ?? id,
    commit: (newFallback) => setOAuthFallbackOrder(configPath, newFallback as LlmProvider[]),
  });
}

async function reorderApiKeysFallbacks(configPath: string): Promise<void> {
  const tier = readApiKeysTier(configPath);
  if (!tier) return;
  await reorderFallbacks({
    primary: tier.primary,
    fallback: tier.fallback,
    providerLabel: (id) => API_KEY_PROVIDERS.find((opt) => opt.value === id)?.label ?? id,
    commit: (newFallback) => setApiKeysFallbackOrder(configPath, newFallback as LlmProvider[]),
  });
}
