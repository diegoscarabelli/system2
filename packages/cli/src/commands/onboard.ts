/**
 * Onboard Command
 *
 * Hybrid onboarding: terminal prompts for API keys, then agent-guided infrastructure setup.
 */

import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as p from '@clack/prompts';
import { copyConfigTemplateIfMissing } from '../utils/config.js';

const SYSTEM2_DIR = join(homedir(), '.system2');
const AUTH_FILE = join(SYSTEM2_DIR, 'auth.json');
const ENV_FILE = join(SYSTEM2_DIR, '.env');

interface OnboardConfig {
  primaryProvider: 'anthropic' | 'openai' | 'google';
  primaryApiKey: string;
  secondaryProvider?: 'anthropic' | 'openai' | 'google';
  secondaryApiKey?: string;
}


export async function onboard(): Promise<void> {
  console.clear();

  // Check for existing installation first
  const isExistingInstallation = existsSync(join(SYSTEM2_DIR, 'auth.json')) ||
                                 existsSync(join(SYSTEM2_DIR, '.env')) ||
                                 existsSync(join(SYSTEM2_DIR, 'app.db'));

  if (isExistingInstallation) {
    p.intro('🧠 Welcome back to System2!');
    console.log('');
    console.log('  It looks like you already completed the onboarding.');
    console.log('  Found existing installation at ~/.system2/');
    console.log('');
    console.log('  To start System2, run:');
    console.log('');
    console.log('    > \x1b[1msystem2 start\x1b[0m');
    console.log('');
    console.log('  To reset and start fresh (only if really necessary):');
    console.log('');
    console.log('    > \x1b[1mmv ~/.system2 ~/.system2.backup\x1b[0m');
    console.log('    > \x1b[1msystem2 onboard\x1b[0m');
    console.log('');
    console.log('  \x1b[2mNote: This archives all conversation history and context.');
    console.log('  System2 will no longer remember previous work. However,');
    console.log('  any data or code you created is preserved in its own');
    console.log('  directories and remains unaffected.\x1b[0m');
    console.log('');
    process.exit(0);
  }

  p.intro('🧠 Welcome to System2!');

  console.log('');
  console.log('  The AI multi-agent system for working with data.');
  console.log('');
  console.log('  It looks like you\'re just getting started.');
  console.log('  Before we can get to work, we need at least one');
  console.log('  LLM provider and an API key for it.');
  console.log('');

  try {

  // Phase 1: Terminal Prompts (Credentials Only)
  const primaryProvider = (await p.select({
    message: 'Select your primary LLM provider',
    options: [
      { value: 'anthropic', label: 'Anthropic', hint: 'Claude models' },
      { value: 'openai', label: 'OpenAI', hint: 'GPT & o-series models' },
      { value: 'google', label: 'Google', hint: 'Gemini models' },
    ],
  })) as 'anthropic' | 'openai' | 'google';

  if (p.isCancel(primaryProvider)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }

  const primaryApiKey = (await p.password({
    message: `Enter your ${primaryProvider} API key`,
    validate: (value) => {
      if (!value) return 'API key is required';
    },
  })) as string;

  if (p.isCancel(primaryApiKey)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }

  const wantsFallback = await p.confirm({
    message: 'Configure a fallback provider?',
    initialValue: false,
  });

  if (p.isCancel(wantsFallback)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }

  let secondaryProvider: 'anthropic' | 'openai' | 'google' | undefined;
  let secondaryApiKey: string | undefined;

  if (wantsFallback) {
    // Filter out the primary provider from secondary options
    const secondaryOptions = [
      { value: 'anthropic', label: 'Anthropic', hint: 'Claude models' },
      { value: 'openai', label: 'OpenAI', hint: 'GPT & o-series models' },
      { value: 'google', label: 'Google', hint: 'Gemini models' },
    ].filter((opt) => opt.value !== primaryProvider);

    secondaryProvider = (await p.select({
      message: 'Select fallback provider',
      options: secondaryOptions,
    })) as 'anthropic' | 'openai' | 'google';

    if (p.isCancel(secondaryProvider)) {
      p.cancel('Onboarding cancelled');
      process.exit(0);
    }

    secondaryApiKey = (await p.password({
      message: `Enter your ${secondaryProvider} API key`,
      validate: (value) => {
        if (!value) return 'API key is required';
      },
    })) as string;

    if (p.isCancel(secondaryApiKey)) {
      p.cancel('Onboarding cancelled');
      process.exit(0);
    }
  }

  const config: OnboardConfig = {
    primaryProvider,
    primaryApiKey,
    secondaryProvider,
    secondaryApiKey,
  };

  // Phase 2: Bootstrap
  const s = p.spinner();
  s.start('Creating ~/.system2 directory...');

  await bootstrap(config);

  s.message('Initializing database...');

  s.stop('✓ System2 configured successfully!');

  p.outro('✨ You\'re all set!');

  console.log('');
  console.log('  Available commands:');
  console.log('');
  console.log('    > \x1b[1msystem2 start\x1b[0m     Launch the gateway and open the browser');
  console.log('    > \x1b[1msystem2 status\x1b[0m    Check if the gateway is running');
  console.log('    > \x1b[1msystem2 stop\x1b[0m      Stop the gateway');
  console.log('');
  console.log('  ─────────────────────────────────────────────────────────');
  console.log('');
  console.log('  Ready to begin? Run:');
  console.log('');
  console.log('    > \x1b[1msystem2 start\x1b[0m');
  console.log('');
  console.log('  Your browser will open and you\'ll meet the Guide —');
  console.log('  your personal interface to System2 that provides');
  console.log('  personalized guidance throughout your analytical journey.');
  console.log('');
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

async function bootstrap(config: OnboardConfig): Promise<void> {
  // Create ~/.system2/ directory structure
  if (!existsSync(SYSTEM2_DIR)) {
    await mkdir(SYSTEM2_DIR, { recursive: true });
  }

  // Create subdirectories
  // Note: Agent-specific session dirs (e.g., sessions/guide-<uid>/) are created
  // by AgentHost when agents are initialized, not during onboarding
  await mkdir(join(SYSTEM2_DIR, 'sessions'), { recursive: true });
  await mkdir(join(SYSTEM2_DIR, 'projects'), { recursive: true });

  // Build auth.json content (Pi SDK AuthStorage format)
  const auth: Record<string, { type: string; key: string }> = {};

  // Map provider to auth.json key
  auth[config.primaryProvider] = { type: 'api_key', key: config.primaryApiKey };

  if (config.secondaryProvider && config.secondaryApiKey) {
    auth[config.secondaryProvider] = { type: 'api_key', key: config.secondaryApiKey };
  }

  // Write auth.json with secure permissions (0600)
  await writeFile(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });

  // Write .env file (provider selection only, not API keys)
  let envContent = `# System2 Configuration
# Generated by onboard command

# Primary LLM Provider
PRIMARY_LLM_PROVIDER=${config.primaryProvider}
`;

  if (config.secondaryProvider) {
    envContent += `
# Secondary LLM Provider (Fallback)
SECONDARY_LLM_PROVIDER=${config.secondaryProvider}
`;
  }

  await writeFile(ENV_FILE, envContent);

  // Copy config.toml template with documented settings
  copyConfigTemplateIfMissing();
}

