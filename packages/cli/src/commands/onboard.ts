/**
 * Onboard Command
 *
 * Interactive setup for new System2 installations.
 * Prompts for LLM providers and API keys, then creates ~/.system2 directory structure.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { copyConfigTemplateIfMissing } from '../utils/config.js';

const SYSTEM2_DIR = join(homedir(), '.system2');
const AUTH_FILE = join(SYSTEM2_DIR, 'auth.json');

type Provider = 'anthropic' | 'openai' | 'google';

interface AuthKey {
  key: string;
  label: string;
}

interface ProviderKeys {
  keys: AuthKey[];
}

interface AuthConfig {
  version: 1;
  primary: Provider;
  fallback: Provider[];
  providers: Record<Provider, ProviderKeys>;
}

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'google', label: 'Google (Gemini)' },
  { value: 'openai', label: 'OpenAI (GPT & o-series)' },
];

function createEmptyProviderKeys(): ProviderKeys {
  return {
    keys: [
      { key: '', label: '' },
      { key: '', label: '' },
    ],
  };
}

/**
 * Collect API keys for a provider (iterative)
 */
async function collectKeysForProvider(provider: Provider): Promise<AuthKey[]> {
  const keys: AuthKey[] = [];
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

export async function onboard(): Promise<void> {
  console.clear();

  // Check for existing installation first
  const isExistingInstallation =
    existsSync(join(SYSTEM2_DIR, 'auth.json')) || existsSync(join(SYSTEM2_DIR, 'app.db'));

  if (isExistingInstallation) {
    p.intro('🧠 Welcome back to System2!');
    p.note(
      'Found existing installation at ~/.system2/\n\n' +
        'To start System2, run:\n' +
        '  system2 start\n\n' +
        'To reset and start fresh:\n' +
        '  mv ~/.system2 ~/.system2.backup\n' +
        '  system2 onboard',
      'Already configured'
    );
    p.log.info(
      'Resetting archives all conversation history and context. System2 will no longer remember previous work. However, any data or code you created is preserved in its own directories.'
    );
    process.exit(0);
  }

  p.intro('🧠 Welcome to System2, the AI multi-agent system for working with data.');

  p.log.info(
    'Before we can get to work, we need at least one LLM provider and an API key. You can configure multiple providers and keys for redundancy and flexibility. This will create ~/.system2, the operational base where System2 lives and works.'
  );

  try {
    const collectedKeys: Map<Provider, AuthKey[]> = new Map();

    // Step 1: Select primary provider
    const primaryProvider = (await p.select({
      message: 'Select your primary LLM provider:',
      options: PROVIDERS,
    })) as Provider;

    if (p.isCancel(primaryProvider)) {
      p.cancel('Onboarding cancelled');
      process.exit(0);
    }

    // Step 2: Collect keys for primary provider
    const primaryKeys = await collectKeysForProvider(primaryProvider);
    collectedKeys.set(primaryProvider, primaryKeys);

    // Step 3: Ask about fallback providers
    const wantsFallback = await p.confirm({
      message: 'Configure fallback providers?',
      initialValue: false,
    });

    if (p.isCancel(wantsFallback)) {
      p.cancel('Onboarding cancelled');
      process.exit(0);
    }

    const fallbackOrder: Provider[] = [];

    if (wantsFallback) {
      // Get available providers (excluding primary)
      const availableProviders = PROVIDERS.filter((p) => p.value !== primaryProvider);

      // Multi-select fallback providers
      const selectedFallbacks = (await p.multiselect({
        message: 'Select fallback providers (in order of preference):',
        options: availableProviders.map((provider) => ({
          value: provider.value,
          label: provider.label,
        })),
        required: false,
      })) as Provider[];

      if (p.isCancel(selectedFallbacks)) {
        p.cancel('Onboarding cancelled');
        process.exit(0);
      }

      // Collect keys for each fallback provider
      for (const fallbackProvider of selectedFallbacks) {
        const providerLabel = PROVIDERS.find((p) => p.value === fallbackProvider)?.label;
        p.log.info(`\nConfiguring ${providerLabel}...`);

        const fallbackKeys = await collectKeysForProvider(fallbackProvider);
        collectedKeys.set(fallbackProvider, fallbackKeys);
        fallbackOrder.push(fallbackProvider);
      }
    }

    // Build auth config with scaffolding
    const authConfig: AuthConfig = {
      version: 1,
      primary: primaryProvider,
      fallback: fallbackOrder,
      providers: {
        anthropic: createEmptyProviderKeys(),
        openai: createEmptyProviderKeys(),
        google: createEmptyProviderKeys(),
      },
    };

    // Populate with collected keys
    for (const [provider, keys] of collectedKeys) {
      // Start with collected keys, then add empty slots to reach at least 2
      const providerKeys = [...keys];
      while (providerKeys.length < 2) {
        providerKeys.push({ key: '', label: '' });
      }
      authConfig.providers[provider] = { keys: providerKeys };
    }

    // Phase 2: Bootstrap
    const s = p.spinner();
    s.start('Creating ~/.system2 directory...');

    await bootstrap(authConfig);

    s.message('Initializing database...');

    s.stop('✓ System2 configured successfully!');

    p.note(
      'system2 start   - Launch the gateway and open the browser\n' +
        'system2 status  - Check if the gateway is running\n' +
        'system2 stop    - Stop the gateway',
      'Available commands'
    );

    p.outro('✨ Run "system2 start" to begin. Your browser will open and you\'ll meet the Guide.');

    p.log.info('To change providers or API keys later, edit ~/.system2/auth.json directly.');
  } catch (error: any) {
    console.error('\n❌ Onboarding failed:');
    console.error(error.message);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

async function bootstrap(authConfig: AuthConfig): Promise<void> {
  // Create ~/.system2/ directory structure
  if (!existsSync(SYSTEM2_DIR)) {
    await mkdir(SYSTEM2_DIR, { recursive: true });
  }

  // Create subdirectories
  // Note: Agent-specific session dirs (e.g., sessions/guide-<uid>/) are created
  // by AgentHost when agents are initialized, not during onboarding
  await mkdir(join(SYSTEM2_DIR, 'sessions'), { recursive: true });
  await mkdir(join(SYSTEM2_DIR, 'projects'), { recursive: true });

  // Write auth.json with secure permissions (0600)
  await writeFile(AUTH_FILE, JSON.stringify(authConfig, null, 2), { mode: 0o600 });

  // Copy config.toml template with documented settings
  copyConfigTemplateIfMissing();
}
