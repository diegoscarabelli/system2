/**
 * Onboard Command
 *
 * Interactive setup for new System2 installations.
 * Prompts for LLM providers, API keys, and optional services,
 * then creates ~/.system2 directory structure with config.toml.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdir as mkdirAsync } from 'node:fs/promises';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import open from 'open';
import pc from 'picocolors';
import { loginProvider } from '../../server/agents/oauth.js';
import { saveOAuthCredentials } from '../../server/agents/oauth-credentials.js';
import type {
  LlmConfig,
  LlmKey,
  LlmOAuthConfig,
  LlmProvider,
  LlmProviderConfig,
  ServicesConfig,
  ToolsConfig,
} from '../../shared/index.js';
import { buildConfigToml, CONFIG_FILE, SYSTEM2_DIR, writeConfigFile } from '../utils/config.js';

const PROVIDERS: { value: LlmProvider; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'cerebras', label: 'Cerebras (fast inference)' },
  { value: 'google', label: 'Google (Gemini)' },
  { value: 'groq', label: 'Groq (fast inference)' },
  { value: 'mistral', label: 'Mistral (Mistral & Magistral)' },
  { value: 'openai', label: 'OpenAI (GPT & o-series)' },
  { value: 'openai-compatible', label: 'OpenAI-compatible (LiteLLM, vLLM, Ollama, Thaura, etc.)' },
  { value: 'openrouter', label: 'OpenRouter (multi-provider gateway)' },
  { value: 'xai', label: 'xAI (Grok)' },
];

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
    value: 'github-copilot',
    label: 'GitHub Copilot',
    hint: 'Uses your GitHub Copilot subscription.',
  },
];

/**
 * Collect API keys for a provider (iterative)
 */
async function collectKeysForProvider(provider: LlmProvider): Promise<LlmKey[]> {
  const keys: LlmKey[] = [];
  const providerLabel = PROVIDERS.find((p) => p.value === provider)?.label || provider;

  // First key is required
  const apiKey = (await p.password({
    message: `Enter your ${providerLabel} API key:`,
    validate: (value) => {
      if (!value) return 'API key is required';
    },
  })) as string;

  if (p.isCancel(apiKey)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }

  const label = (await p.text({
    message: 'Label for this key (e.g., "personal", "work"):',
    placeholder: 'default',
    defaultValue: 'default',
  })) as string;

  if (p.isCancel(label)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }

  keys.push({ key: apiKey, label: label || 'default' });

  // Ask for additional keys
  let addMore = await p.confirm({
    message: `Add another ${providerLabel} API key?`,
    initialValue: false,
  });

  if (p.isCancel(addMore)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }

  while (addMore) {
    const extraKey = (await p.password({
      message: `Enter another ${providerLabel} API key:`,
      validate: (value) => {
        if (!value) return 'API key is required';
      },
    })) as string;

    if (p.isCancel(extraKey)) {
      p.cancel('Onboarding cancelled');
      process.exit(0);
    }

    const extraLabel = (await p.text({
      message: 'Label for this key:',
      placeholder: 'default',
    })) as string;

    if (p.isCancel(extraLabel)) {
      p.cancel('Onboarding cancelled');
      process.exit(0);
    }

    keys.push({ key: extraKey, label: extraLabel || `key-${keys.length + 1}` });

    addMore = await p.confirm({
      message: `Add another ${providerLabel} API key?`,
      initialValue: false,
    });

    if (p.isCancel(addMore)) {
      p.cancel('Onboarding cancelled');
      process.exit(0);
    }
  }

  return keys;
}

/**
 * Collect configuration for an OpenAI-compatible endpoint (base URL, model, optional API key).
 */
async function collectOpenAICompatibleConfig(): Promise<{
  keys: LlmKey[];
  base_url: string;
  model: string;
  compat_reasoning: boolean;
}> {
  const baseUrl = (await p.text({
    message: 'Enter the base URL of your OpenAI-compatible endpoint:',
    placeholder: 'http://localhost:4000/v1',
    validate: (value) => {
      if (!value) return 'Base URL is required';
      try {
        new URL(value);
      } catch {
        return 'Invalid URL format';
      }
    },
  })) as string;

  if (p.isCancel(baseUrl)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }

  const model = (await p.text({
    message: 'Enter the model ID to use:',
    placeholder: 'gpt-4o',
    validate: (value) => {
      if (!value) return 'Model ID is required';
    },
  })) as string;

  if (p.isCancel(model)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }

  const needsKey = await p.confirm({
    message: 'Does this endpoint require an API key?',
    initialValue: true,
  });

  if (p.isCancel(needsKey)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }

  let keys: LlmKey[];
  if (needsKey) {
    keys = await collectKeysForProvider('openai-compatible');
  } else {
    keys = [{ key: 'not-needed', label: 'local' }];
  }

  const reasoning = await p.confirm({
    message: 'Does this model support reasoning/extended thinking?',
    initialValue: true,
  });

  if (p.isCancel(reasoning)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }

  return { keys, base_url: baseUrl, model, compat_reasoning: reasoning };
}

/**
 * Collect optional Brave Search API key for web search.
 */
async function collectWebSearchConfig(): Promise<{
  services?: ServicesConfig;
  tools?: ToolsConfig;
}> {
  const wantsWebSearch = await p.confirm({
    message: 'Configure web search? (uses Brave Search API)',
    initialValue: false,
  });

  if (p.isCancel(wantsWebSearch)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }

  if (!wantsWebSearch) return {};

  const braveKey = (await p.password({
    message: 'Enter your Brave Search API key:',
    validate: (value) => {
      if (!value) return 'API key is required';
    },
  })) as string;

  if (p.isCancel(braveKey)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }

  return {
    services: { brave_search: { key: braveKey } },
    tools: { web_search: { enabled: true, max_results: 5 } },
  };
}

/**
 * Run the OAuth login flow for a given provider.
 * Returns { label } on success, null on failure.
 */
async function runOAuthLogin(provider: LlmProvider): Promise<{ label: string } | null> {
  const defaultLabel = provider; // default label = provider id

  const label = (await p.text({
    message: 'Label for this OAuth credential:',
    placeholder: defaultLabel,
    defaultValue: defaultLabel,
  })) as string;

  if (p.isCancel(label)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }

  if (!existsSync(SYSTEM2_DIR)) {
    await mkdirAsync(SYSTEM2_DIR, { recursive: true });
  }

  const s = p.spinner();
  s.start('Waiting for browser authentication...');
  try {
    const creds = await loginProvider(provider, {
      onAuth: ({ url }) => {
        // Stop, print the URL persistently, attempt to open the browser, then
        // restart the spinner. s.message() would be overwritten on the next
        // onProgress; p.log.info() under an active spinner is suppressed.
        // Stop+log+restart guarantees the URL stays visible. open() is
        // best-effort.
        s.stop('Browser authentication required:');
        p.log.info(`Open this URL to authenticate (browser should open automatically):\n${url}`);
        void open(url).catch(() => {
          // Browser open failed — URL is already printed; user copies manually.
        });
        s.start('Waiting for OAuth callback...');
      },
      onPrompt: async ({ message, placeholder }) => {
        s.stop('Browser callback timed out');
        const value = (await p.text({ message, placeholder })) as string;
        if (p.isCancel(value)) {
          p.cancel('Onboarding cancelled');
          process.exit(0);
        }
        s.start('Exchanging code...');
        return value;
      },
      onProgress: (m) => s.message(m),
    });
    // Spread preserves provider-specific extras (e.g. Copilot's enterpriseDomain).
    saveOAuthCredentials(SYSTEM2_DIR, provider, {
      ...creds,
      label: label || defaultLabel,
    });
    s.stop('✓ OAuth login successful');
    return { label: label || defaultLabel };
  } catch (err) {
    s.stop('✗ OAuth login failed');
    p.log.error(err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Collect the OAuth tier configuration.
 * Returns LlmOAuthConfig if configured, null if skipped or failed.
 */
async function collectOAuthTier(): Promise<LlmOAuthConfig | null> {
  const wantsOAuth = await p.confirm({
    message: 'Configure OAuth providers? (use existing AI subscriptions instead of API keys)',
    initialValue: true,
  });
  if (p.isCancel(wantsOAuth)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }
  if (!wantsOAuth) return null;

  let availableOAuth = [...OAUTH_PROVIDERS];
  let primary: LlmProvider | undefined;

  // Outer loop: keep trying primary candidates until one succeeds or the user gives up.
  while (!primary && availableOAuth.length > 0) {
    const candidate = (await p.select({
      message: 'Select your primary OAuth provider:',
      options: availableOAuth,
    })) as LlmProvider;
    if (p.isCancel(candidate)) {
      p.cancel('Onboarding cancelled');
      process.exit(0);
    }

    const result = await runOAuthLogin(candidate);
    if (result) {
      primary = candidate;
      availableOAuth = availableOAuth.filter((o) => o.value !== candidate);
      break;
    }

    // Login failed: 3-way choice. Retrying re-shows the candidate; "different" removes it.
    const next = (await p.select({
      message: 'OAuth login failed. What now?',
      options: [
        { value: 'retry', label: `Retry ${candidate}` },
        { value: 'different', label: 'Try a different OAuth provider' },
        { value: 'skip', label: 'Skip OAuth tier (continue with API keys only)' },
      ],
    })) as 'retry' | 'different' | 'skip';
    if (p.isCancel(next)) {
      p.cancel('Onboarding cancelled');
      process.exit(0);
    }
    if (next === 'retry') continue;
    if (next === 'skip') return null;
    // 'different': drop the failed candidate so the next select doesn't re-offer it.
    availableOAuth = availableOAuth.filter((o) => o.value !== candidate);
  }

  if (!primary) {
    p.log.warn('No OAuth providers succeeded; skipping OAuth tier.');
    return null;
  }

  // Rebuild fallback options from the full provider list (minus the chosen primary).
  // Don't reuse availableOAuth: it has been pruned of providers the user gave up on as
  // primary candidates, but a transient primary failure shouldn't permanently disqualify
  // them from being tried as fallback.
  const fallback: LlmProvider[] = [];
  let availableFallback = OAUTH_PROVIDERS.filter((o) => o.value !== primary);
  while (availableFallback.length > 0) {
    const addMore = await p.confirm({
      message: 'Add another OAuth provider as fallback?',
      initialValue: false,
    });
    if (p.isCancel(addMore)) {
      p.cancel('Onboarding cancelled');
      process.exit(0);
    }
    if (!addMore) break;

    const next = (await p.select({
      message: 'Select fallback OAuth provider:',
      options: availableFallback,
    })) as LlmProvider;
    if (p.isCancel(next)) {
      p.cancel('Onboarding cancelled');
      process.exit(0);
    }
    const r = await runOAuthLogin(next);
    if (r) {
      fallback.push(next);
    }
    availableFallback = availableFallback.filter((o) => o.value !== next);
  }

  return { primary, fallback, providers: {} };
}

/**
 * Collect the API key tier configuration.
 * Returns { llm: null } if user opts out, otherwise the full provider config.
 */
async function collectApiKeyTier(): Promise<{
  llm: {
    primary: LlmProvider;
    fallback: LlmProvider[];
    providers: Partial<Record<LlmProvider, LlmProviderConfig>>;
  } | null;
  services?: ServicesConfig;
  tools?: ToolsConfig;
}> {
  const wantsApiKeys = await p.confirm({
    message: 'Configure API key providers? (recommended as fallback when OAuth rate-limits)',
    initialValue: true,
  });
  if (p.isCancel(wantsApiKeys)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }
  if (!wantsApiKeys) {
    return { llm: null };
  }

  const collectedKeys: Map<LlmProvider, LlmKey[]> = new Map();

  // Step 1: Select primary provider
  const primaryProvider = (await p.select({
    message: 'Select your primary LLM provider:',
    options: PROVIDERS,
  })) as LlmProvider;

  if (p.isCancel(primaryProvider)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }

  // Step 2: Collect keys for primary provider (openai-compatible needs extra config)
  let compatExtras: { base_url: string; model: string; compat_reasoning: boolean } | undefined;

  if (primaryProvider === 'openai-compatible') {
    const compatConfig = await collectOpenAICompatibleConfig();
    collectedKeys.set(primaryProvider, compatConfig.keys);
    compatExtras = {
      base_url: compatConfig.base_url,
      model: compatConfig.model,
      compat_reasoning: compatConfig.compat_reasoning,
    };
  } else {
    const primaryKeys = await collectKeysForProvider(primaryProvider);
    collectedKeys.set(primaryProvider, primaryKeys);
  }

  // Step 3: Ask about fallback providers
  const wantsFallback = await p.confirm({
    message: 'Configure fallback providers?',
    initialValue: false,
  });

  if (p.isCancel(wantsFallback)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }

  const fallbackOrder: LlmProvider[] = [];

  if (wantsFallback) {
    let availableProviders = PROVIDERS.filter((p) => p.value !== primaryProvider);

    while (availableProviders.length > 0) {
      const fallbackProvider = (await p.select({
        message:
          fallbackOrder.length === 0
            ? 'Select a fallback provider:'
            : 'Select another fallback provider:',
        options: availableProviders,
      })) as LlmProvider;

      if (p.isCancel(fallbackProvider)) {
        p.cancel('Onboarding cancelled');
        process.exit(0);
      }

      if (fallbackProvider === 'openai-compatible' && !compatExtras) {
        const compatConfig = await collectOpenAICompatibleConfig();
        collectedKeys.set(fallbackProvider, compatConfig.keys);
        compatExtras = {
          base_url: compatConfig.base_url,
          model: compatConfig.model,
          compat_reasoning: compatConfig.compat_reasoning,
        };
      } else {
        const fallbackKeys = await collectKeysForProvider(fallbackProvider);
        collectedKeys.set(fallbackProvider, fallbackKeys);
      }
      fallbackOrder.push(fallbackProvider);

      availableProviders = availableProviders.filter((p) => p.value !== fallbackProvider);

      if (availableProviders.length > 0) {
        const addMore = await p.confirm({
          message: 'Add another fallback provider?',
          initialValue: false,
        });

        if (p.isCancel(addMore)) {
          p.cancel('Onboarding cancelled');
          process.exit(0);
        }

        if (!addMore) break;
      }
    }
  }

  // Build providers map
  const providers: Partial<Record<LlmProvider, LlmProviderConfig>> = {};
  for (const [provider, keys] of collectedKeys) {
    if (provider === 'openai-compatible' && compatExtras) {
      providers[provider] = {
        keys,
        base_url: compatExtras.base_url,
        model: compatExtras.model,
        compat_reasoning: compatExtras.compat_reasoning,
      };
    } else {
      providers[provider] = { keys };
    }
  }

  return {
    llm: {
      primary: primaryProvider,
      fallback: fallbackOrder,
      providers,
    },
  };
}

export async function onboard(): Promise<void> {
  console.clear();

  // Check for existing installation first
  const isExistingInstallation = existsSync(CONFIG_FILE) || existsSync(join(SYSTEM2_DIR, 'app.db'));

  if (isExistingInstallation) {
    p.intro('🧠 Welcome back to System2!');
    p.log.info(
      'Found existing installation at ~/.system2/\n\n' +
        'To start System2, run:\n' +
        `  > ${pc.bold('system2 start')}\n\n` +
        'To start fresh (this will reset System2, losing memory of all previous work):\n' +
        `  > ${pc.bold('mv ~/.system2 ~/.system2.backup')}\n` +
        `  > ${pc.bold('system2 onboard')}`
    );
    process.exit(0);
  }

  p.intro('🧠 Welcome to System2, the AI multi-agent system for working with data.');

  p.log.info(
    'Before we can get to work, we need at least one LLM provider configured. ' +
      'You can use an OAuth subscription (Anthropic, OpenAI Codex, or GitHub Copilot) ' +
      'and/or API keys for any of the supported providers. ' +
      'You can change this later: run `system2 login` to add, remove, or change the ' +
      'primary OAuth provider, or edit `~/.system2/config.toml` directly to update ' +
      'API keys and per-role pins.'
  );

  try {
    // Phase 1a: OAuth tier
    const oauthTier = await collectOAuthTier();

    // Phase 1b: API key tier
    const apiKeyTier = await collectApiKeyTier();

    // Validate: at least one tier must be configured
    if (!oauthTier && !apiKeyTier.llm) {
      p.log.error('At least one auth tier (OAuth or API keys) must be configured.');
      p.cancel('Onboarding cancelled');
      process.exit(1);
    }

    // Build LLM config — at this point at least one tier is non-null (validated above)
    let llmConfig: LlmConfig;
    if (apiKeyTier.llm) {
      llmConfig = { ...apiKeyTier.llm };
    } else {
      // oauthTier is guaranteed non-null: both-null case already exited above
      const oauthPrimary = (oauthTier as LlmOAuthConfig).primary;
      llmConfig = {
        primary: oauthPrimary,
        fallback: [],
        providers: { [oauthPrimary]: { keys: [] } },
      };
    }

    if (oauthTier) {
      llmConfig.oauth = oauthTier;
    }

    // Phase 1c: Web search
    const { services, tools } = await collectWebSearchConfig();

    // Phase 2: Bootstrap
    const s = p.spinner();
    s.start('Creating ~/.system2 installation directory...');

    await bootstrap({ llm: llmConfig, services, tools });

    s.message('Initializing System2 database...');

    s.stop('✓ System2 configured successfully!');

    p.log.info(
      'Created the installation directory ~/.system2, where System2 lives and works.\n' +
        'To change providers or API keys, edit ~/.system2/config.toml directly.\n\n' +
        'Available commands:\n' +
        `  > ${pc.bold('system2 start')}   (launch the server and open the browser)\n` +
        `  > ${pc.bold('system2 status')}  (check if the server is running)\n` +
        `  > ${pc.bold('system2 stop')}    (stop the server)`
    );

    p.outro(`✨ Run ${pc.bold('system2 start')} to launch. The Guide will help you get started.`);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('\n❌ Onboarding failed:');
    console.error(err.message);
    if (err.stack) {
      console.error('\nStack trace:');
      console.error(err.stack);
    }
    process.exit(1);
  }
}

async function bootstrap(config: {
  llm: LlmConfig;
  services?: ServicesConfig;
  tools?: ToolsConfig;
}): Promise<void> {
  // Create ~/.system2/ directory structure
  if (!existsSync(SYSTEM2_DIR)) {
    await mkdir(SYSTEM2_DIR, { recursive: true });
  }

  // Create subdirectories
  // Note: Agent-specific session dirs (e.g., sessions/guide-<uid>/) are created
  // by AgentHost when agents are initialized, not during onboarding
  await mkdir(join(SYSTEM2_DIR, 'sessions'), { recursive: true });
  await mkdir(join(SYSTEM2_DIR, 'projects'), { recursive: true });
  await mkdir(join(SYSTEM2_DIR, 'artifacts'), { recursive: true });

  // Write config.toml with all settings and secure permissions (0600)
  const tomlContent = buildConfigToml({
    llm: config.llm,
    services: config.services,
    tools: config.tools,
  });
  writeConfigFile(tomlContent);
}
