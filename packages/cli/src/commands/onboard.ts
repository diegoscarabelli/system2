/**
 * Onboard Command
 *
 * Interactive setup for new System2 installations.
 * Prompts for LLM providers, API keys, and optional services,
 * then creates ~/.system2 directory structure with config.toml.
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import type { LlmConfig, LlmKey, LlmProvider, ServicesConfig, ToolsConfig } from '@system2/shared';
import pc from 'picocolors';
import { buildConfigToml, CONFIG_FILE, SYSTEM2_DIR, writeConfigFile } from '../utils/config.js';

const PROVIDERS: { value: LlmProvider; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'google', label: 'Google (Gemini)' },
  { value: 'openai', label: 'OpenAI (GPT & o-series)' },
  { value: 'mistral', label: 'Mistral (Mistral & Magistral)' },
  { value: 'openrouter', label: 'OpenRouter (multi-provider gateway)' },
  { value: 'xai', label: 'xAI (Grok)' },
  { value: 'groq', label: 'Groq (fast inference)' },
  { value: 'cerebras', label: 'Cerebras (fast inference)' },
  { value: 'openai-compatible', label: 'OpenAI-compatible (LiteLLM, vLLM, Ollama, Thaura, etc.)' },
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
    'Before we can get to work, we need at least one LLM provider and an API key. ' +
      'You can configure multiple providers and keys for redundancy and flexibility. ' +
      "Don't worry, you can always change or add providers and keys later by editing ~/.system2/config.toml directly."
  );

  try {
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

    // Step 4: Ask about web search
    const { services, tools } = await collectWebSearchConfig();

    // Build LLM config
    const llmConfig: LlmConfig = {
      primary: primaryProvider,
      fallback: fallbackOrder,
      providers: {},
    };

    for (const [provider, keys] of collectedKeys) {
      if (provider === 'openai-compatible' && compatExtras) {
        llmConfig.providers[provider] = {
          keys,
          base_url: compatExtras.base_url,
          model: compatExtras.model,
          compat_reasoning: compatExtras.compat_reasoning,
        };
      } else {
        llmConfig.providers[provider] = { keys };
      }
    }

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

  // Write config.toml with all settings and secure permissions (0600)
  const tomlContent = buildConfigToml({
    llm: config.llm,
    services: config.services,
    tools: config.tools,
  });
  writeConfigFile(tomlContent);
}
