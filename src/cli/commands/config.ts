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

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir as mkdirAsync } from 'node:fs/promises';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import open from 'open';
import pc from 'picocolors';
import { loginProvider } from '../../server/agents/oauth.js';
import { saveOAuthCredentials } from '../../server/agents/oauth-credentials.js';
import type { LlmKey, LlmProvider } from '../../shared/index.js';
import { authDir, authFile, loadAuthToml } from '../utils/auth-config.js';
import { CONFIG_FILE, SYSTEM2_DIR } from '../utils/config.js';
import { formatOAuthAuthMessage } from '../utils/oauth-format.js';
import {
  addKeyToApiKeyProvider,
  addProviderToApiKeysTier,
  addProviderToOAuthTier,
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
  const authPath = authFile(system2Dir);

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

  // Upfront TOML validation for auth.toml: surface a clean parse error and
  // exit rather than letting any of the submenus / patchers crash mid-flow
  // with a stack trace. Skipped when the file doesn't exist (the post-init,
  // pre-config state) — patchers create it on first write.
  if (existsSync(authPath)) {
    try {
      loadAuthToml(authPath);
    } catch (err) {
      p.intro('🧠 System2 configuration');
      p.cancel(
        `auth.toml could not be parsed:\n  ${err instanceof Error ? err.message : String(err)}\n\n` +
          `Fix the syntax error in ${authPath} manually, or delete the file and rerun ` +
          'system2 config to recreate it.'
      );
      process.exit(1);
    }
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

    if (choice === 'oauth') await oauthSubmenu(authPath, system2Dir);
    else if (choice === 'api_keys') await apiKeysSubmenu(authPath);
    else await servicesSubmenu(authPath);
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

async function oauthSubmenu(authPath: string, system2Dir: string): Promise<void> {
  const oauthDir = authDir(system2Dir);

  while (true) {
    const tier = readOAuthTier(authPath);
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
      await reorderOAuthFallbacks(authPath);
      continue;
    }

    await handleOAuthProvider(authPath, system2Dir, target as LlmProvider);
  }
}

async function handleOAuthProvider(
  authPath: string,
  system2Dir: string,
  target: LlmProvider
): Promise<void> {
  const oauthDir = authDir(system2Dir);
  const isAlreadyLoggedIn = existsSync(join(oauthDir, `${target}.json`));

  if (isAlreadyLoggedIn) {
    const tierBefore = readOAuthTier(authPath);
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
      await removeOAuthProviderCredentials(authPath, system2Dir, target);
      return;
    }
    if (action === 'promote') {
      try {
        const r = setProviderAsPrimary(authPath, target);
        if (r.changed) p.log.info(`✓ Set ${target} as primary OAuth provider`);
        else p.log.info(`${target} was already primary — no changes`);
      } catch (err) {
        p.log.error(err instanceof Error ? err.message : String(err));
      }
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

  // Auto-patch auth.toml. The credential is useless until [llm.oauth]
  // references it. We've already saved the credential file, so a throw here
  // would leave the user with a valid OAuth credential that the runtime can't
  // see — surface the error and return to the submenu instead of crashing.
  try {
    const patchResult = addProviderToOAuthTier(authPath, target);
    if (patchResult.changed) {
      p.log.info(`✓ Updated [llm.oauth] in ${authPath}`);
    }
  } catch (err) {
    p.log.error(err instanceof Error ? err.message : String(err));
    return;
  }

  // Offer to promote, only when there's an existing different primary.
  const tier = readOAuthTier(authPath);
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
      const r = setProviderAsPrimary(authPath, target);
      if (r.changed) p.log.info(`✓ Set ${target} as primary OAuth provider`);
    }
  }
}

async function removeOAuthProviderCredentials(
  authPath: string,
  system2Dir: string,
  provider: LlmProvider
): Promise<void> {
  const credPath = join(authDir(system2Dir), `${provider}.json`);
  if (existsSync(credPath)) {
    rmSync(credPath);
    p.log.info(`✓ Deleted ${credPath}`);
  } else {
    p.log.info(`No credentials file at ${credPath}`);
  }
  const result = removeProviderFromOAuthTier(authPath, provider);
  if (result.changed) {
    p.log.info(`✓ Removed ${provider} from [llm.oauth] in ${authPath}`);
  } else {
    p.log.info(`${provider} was not in [llm.oauth] — no config change`);
  }
}

// ─── API keys submenu ─────────────────────────────────────────────────────────

async function apiKeysSubmenu(authPath: string): Promise<void> {
  while (true) {
    const tier = readApiKeysTier(authPath);
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
      await reorderApiKeysFallbacks(authPath);
      continue;
    }

    await handleApiKeyProvider(authPath, target as LlmProvider);
  }
}

async function handleApiKeyProvider(authPath: string, target: LlmProvider): Promise<void> {
  const tier = readApiKeysTier(authPath);
  const isConfigured = tier?.providers.has(target) ?? false;

  if (!isConfigured) {
    await addNewApiKeyProvider(authPath, target);
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
      addKeyToApiKeyProvider(authPath, target, k);
      p.log.info(`✓ Added key "${k.label}" to ${target}`);
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
    }
    return;
  }

  if (action === 'replace') {
    const existingKeys = readApiKeyProviderKeys(authPath, target);
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
    try {
      replaceKeyInApiKeyProvider(authPath, target, labelChoice as string, newKeyValue as string);
      p.log.info(`✓ Replaced key "${labelChoice}" for ${target}`);
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
    }
    return;
  }

  if (action === 'primary') {
    try {
      const r = setApiKeyProviderAsPrimary(authPath, target);
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
    try {
      const r = removeProviderFromApiKeysTier(authPath, target);
      if (r.changed) p.log.info(`✓ Removed ${target} from [llm.api_keys]`);
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
    }
  }
}

async function addNewApiKeyProvider(authPath: string, target: LlmProvider): Promise<void> {
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
    // Pass extras into the patcher so the provider lands atomically with
    // base_url/model/compat_reasoning if openai-compatible. No rollback dance
    // needed — it's a single parse → mutate → write.
    addProviderToApiKeysTier(authPath, target, keys, extras);
  } catch (err) {
    p.log.error(err instanceof Error ? err.message : String(err));
    return;
  }
  p.log.info(`✓ Added ${target} to [llm.api_keys]`);

  // If a primary already exists, offer to promote.
  const tier = readApiKeysTier(authPath);
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
      const r = setApiKeyProviderAsPrimary(authPath, target);
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

function readApiKeyProviderKeys(authPath: string, provider: LlmProvider): LlmKey[] {
  const parsed = loadAuthToml(authPath);
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

// ─── Services (Brave Search) submenu ──────────────────────────────────────────

async function servicesSubmenu(authPath: string): Promise<void> {
  while (true) {
    const configured = isBraveSearchConfigured(authPath);
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
    if (choice === 'brave') await handleBraveSearch(authPath, configured);
  }
}

function isBraveSearchConfigured(authPath: string): boolean {
  const parsed = loadAuthToml(authPath);
  return Boolean(parsed.services?.brave_search?.key);
}

async function handleBraveSearch(authPath: string, configured: boolean): Promise<void> {
  if (!configured) {
    const key = (await p.password({
      message: 'Enter your Brave Search API key:',
    })) as string | symbol;
    if (p.isCancel(key) || !key) return;
    setBraveSearchKey(authPath, key as string);
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
    setBraveSearchKey(authPath, key as string);
    p.log.info('✓ Brave Search key replaced');
  }
  if (action === 'remove') {
    const confirmed = await p.confirm({
      message: 'Remove Brave Search and disable web search tool?',
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) return;
    removeBraveSearch(authPath);
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

async function reorderOAuthFallbacks(authPath: string): Promise<void> {
  const tier = readOAuthTier(authPath);
  if (!tier) return;
  await reorderFallbacks({
    primary: tier.primary,
    fallback: tier.fallback,
    providerLabel: (id) => OAUTH_PROVIDERS.find((opt) => opt.value === id)?.label ?? id,
    commit: (newFallback) => setOAuthFallbackOrder(authPath, newFallback as LlmProvider[]),
  });
}

async function reorderApiKeysFallbacks(authPath: string): Promise<void> {
  const tier = readApiKeysTier(authPath);
  if (!tier) return;
  await reorderFallbacks({
    primary: tier.primary,
    fallback: tier.fallback,
    providerLabel: (id) => API_KEY_PROVIDERS.find((opt) => opt.value === id)?.label ?? id,
    commit: (newFallback) => setApiKeysFallbackOrder(authPath, newFallback as LlmProvider[]),
  });
}
