/**
 * Start Command
 *
 * Starts the System2 gateway server for subsequent runs (after onboarding).
 */

import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import { Server } from '@system2/gateway';
import open from 'open';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYSTEM2_DIR = join(homedir(), '.system2');
const ENV_FILE = join(SYSTEM2_DIR, '.env');
const DB_FILE = join(SYSTEM2_DIR, 'app.db');
const UI_DIST_PATH = join(__dirname, '..', '..', 'ui', 'dist');

export async function start(options: { port?: number; noBrowser?: boolean }): Promise<void> {
  // Check if onboarded
  if (!existsSync(ENV_FILE)) {
    console.error('Error: System2 has not been onboarded yet.');
    console.error('Please run: system2 onboard');
    process.exit(1);
  }

  // Load environment variables from .env
  dotenvConfig({ path: ENV_FILE });

  // Get LLM provider from environment
  const primaryProvider = process.env.PRIMARY_LLM_PROVIDER as 'anthropic' | 'openai' | 'google';
  if (!primaryProvider) {
    console.error('Error: PRIMARY_LLM_PROVIDER not found in .env file');
    process.exit(1);
  }

  // Determine LLM model based on provider
  const modelMap: Record<string, string> = {
    anthropic: 'claude-sonnet-4-5',
    openai: 'gpt-4o',
    google: 'gemini-3.1-pro',
  };

  const model = modelMap[primaryProvider];
  const port = options.port || 3000;

  console.log('Starting System2 Gateway...');
  console.log(`  Provider: ${primaryProvider}`);
  console.log(`  Model: ${model}`);
  console.log(`  Port: ${port}`);
  console.log('');

  // Start server
  const server = new Server({
    port,
    dbPath: DB_FILE,
    llmProvider: primaryProvider,
    llmModel: model,
    uiDistPath: UI_DIST_PATH,
  });

  await server.start();

  // Open browser unless --no-browser flag
  if (!options.noBrowser) {
    console.log('Opening browser...');
    await open(`http://localhost:${port}`);
  }

  console.log('');
  console.log('✅ System2 is ready!');
  console.log('');
  console.log('The Guide agent is active and ready to help you.');
  console.log('');
  console.log('Press Ctrl+C to stop the server');
  console.log('');

  // Keep server running
  await new Promise(() => {});
}
