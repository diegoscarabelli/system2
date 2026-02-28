/**
 * Onboard Command
 *
 * Hybrid onboarding: terminal prompts for API keys, then agent-guided infrastructure setup.
 */

import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import * as p from '@clack/prompts';
import { Server, GUIDE_MODEL_OPTIONS } from '@system2/gateway';
import open from 'open';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYSTEM2_DIR = join(homedir(), '.system2');
const ENV_FILE = join(SYSTEM2_DIR, '.env');
const DB_FILE = join(SYSTEM2_DIR, 'app.db');
// UI dist path: from CLI dist to ui dist (../../ui/dist)
const UI_DIST_PATH = join(__dirname, '..', '..', 'ui', 'dist');

interface OnboardConfig {
  primaryProvider: 'anthropic' | 'openai' | 'google';
  primaryModel: string;
  primaryApiKey: string;
  secondaryProvider?: 'anthropic' | 'openai' | 'google';
  secondaryModel?: string;
  secondaryApiKey?: string;
}


export async function onboard(): Promise<void> {
  console.clear();

  p.intro('🦞 System2 Onboarding');

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

  // Select model for primary provider
  const primaryModel = (await p.select({
    message: `Select ${primaryProvider} model`,
    options: GUIDE_MODEL_OPTIONS[primaryProvider],
  })) as string;

  if (p.isCancel(primaryModel)) {
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
  let secondaryModel: string | undefined;
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

    // Select model for secondary provider
    secondaryModel = (await p.select({
      message: `Select ${secondaryProvider} model`,
      options: GUIDE_MODEL_OPTIONS[secondaryProvider],
    })) as string;

    if (p.isCancel(secondaryModel)) {
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
    primaryModel,
    primaryApiKey,
    secondaryProvider,
    secondaryModel,
    secondaryApiKey,
  };

  // Phase 2: Bootstrap
  const s = p.spinner();
  s.start('Creating ~/.system2 directory...');

  await bootstrap(config);

  s.message('Initializing database...');

  // Phase 3: Launch
  s.message('Starting gateway server...');
  await launch(config, s);
}

async function bootstrap(config: OnboardConfig): Promise<void> {
  // Create ~/.system2/ directory structure
  if (!existsSync(SYSTEM2_DIR)) {
    await mkdir(SYSTEM2_DIR, { recursive: true });
  }

  // Create subdirectories
  await mkdir(join(SYSTEM2_DIR, 'agents'), { recursive: true });
  await mkdir(join(SYSTEM2_DIR, 'projects'), { recursive: true });
  await mkdir(join(SYSTEM2_DIR, 'artifacts'), { recursive: true });

  // Write .env file
  let envContent = `# System2 Configuration
# Generated by onboard command

# Primary LLM Provider
PRIMARY_LLM_PROVIDER=${config.primaryProvider}
PRIMARY_LLM_MODEL=${config.primaryModel}
${getApiKeyEnvVar(config.primaryProvider)}=${config.primaryApiKey}
`;

  if (config.secondaryProvider && config.secondaryModel && config.secondaryApiKey) {
    envContent += `
# Secondary LLM Provider (Fallback)
SECONDARY_LLM_PROVIDER=${config.secondaryProvider}
SECONDARY_LLM_MODEL=${config.secondaryModel}
${getApiKeyEnvVar(config.secondaryProvider)}=${config.secondaryApiKey}
`;
  }

  await writeFile(ENV_FILE, envContent);
}

async function launch(config: OnboardConfig, s: ReturnType<typeof p.spinner>): Promise<void> {
  // Set API keys in environment (Pi SDK reads from process.env)
  process.env[getApiKeyEnvVar(config.primaryProvider)] = config.primaryApiKey;
  if (config.secondaryProvider && config.secondaryApiKey) {
    process.env[getApiKeyEnvVar(config.secondaryProvider)] = config.secondaryApiKey;
  }

  // Start server
  const server = new Server({
    port: 3000,
    dbPath: DB_FILE,
    llmProvider: config.primaryProvider,
    llmModel: config.primaryModel,
    uiDistPath: UI_DIST_PATH,
  });

  await server.start();

  s.stop('Gateway running on http://localhost:3000');

  p.outro('✨ System2 is ready!');

  console.log('');
  console.log('The Guide agent is now active and ready to help you:');
  console.log('  • Detect your system and installed tools');
  console.log('  • Configure your data stack (databases, orchestration)');
  console.log('  • Set up your pipelines repository');
  console.log('');
  console.log('Opening browser...');
  console.log('');

  // Open browser
  await open('http://localhost:3000');

  console.log('Press Ctrl+C to stop the server');
  console.log('');

  // Keep server running
  await new Promise(() => {});
}

function getApiKeyEnvVar(provider: string): string {
  const map: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GEMINI_API_KEY',
  };
  return map[provider];
}
