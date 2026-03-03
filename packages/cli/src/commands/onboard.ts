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
import pc from 'picocolors';
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
      'Don\'t worry, you can always change or add providers and keys later by editing ~/.system2/auth.json directly.'
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
      // Iteratively add fallback providers (same UX as primary selection)
      let availableProviders = PROVIDERS.filter((p) => p.value !== primaryProvider);

      while (availableProviders.length > 0) {
        const fallbackProvider = (await p.select({
          message:
            fallbackOrder.length === 0
              ? 'Select a fallback provider:'
              : 'Select another fallback provider:',
          options: availableProviders,
        })) as Provider;

        if (p.isCancel(fallbackProvider)) {
          p.cancel('Onboarding cancelled');
          process.exit(0);
        }

        // Collect keys for this fallback provider
        const fallbackKeys = await collectKeysForProvider(fallbackProvider);
        collectedKeys.set(fallbackProvider, fallbackKeys);
        fallbackOrder.push(fallbackProvider);

        // Remove from available list
        availableProviders = availableProviders.filter((p) => p.value !== fallbackProvider);

        // Ask about adding more (if any remain)
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

    // Build auth config with scaffolding
    const authConfig: AuthConfig = {
      version: 1,
      primary: primaryProvider,
      fallback: fallbackOrder,
      providers: {
        anthropic: createEmptyProviderKeys(),
        google: createEmptyProviderKeys(),
        openai: createEmptyProviderKeys(),
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
    s.start('Creating ~/.system2 installation directory...');

    await bootstrap(authConfig);

    s.message('Initializing System2 database...');

    s.stop('✓ System2 configured successfully!');

    p.log.info(
      'Created the installation directory ~/.system2, where System2 lives and works.\n' +
        'To change providers or API keys, edit ~/.system2/auth.json directly.\n\n' +
        'Available commands:\n' +
        `  > ${pc.bold('system2 start')}   (launch the server and open the browser)\n` +
        `  > ${pc.bold('system2 status')}  (check if the server is running)\n` +
        `  > ${pc.bold('system2 stop')}    (stop the server)`
    );

    p.outro(`✨ Run ${pc.bold('system2 start')} to launch. The Guide will help you get started.`);
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
