import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmProvider } from '../../shared/index.js';
import { log } from '../utils/logger.js';

export interface OAuthCredentials {
  access: string;
  refresh: string;
  /** Epoch ms when access token expires (already includes pi-ai's 5 min safety buffer). */
  expires: number;
  label: string;
}

const OAUTH_DIR = 'oauth';

function credentialsPath(system2Dir: string, provider: LlmProvider): string {
  return join(system2Dir, OAUTH_DIR, `${provider}.json`);
}

export function loadOAuthCredentials(
  system2Dir: string,
  provider: LlmProvider
): OAuthCredentials | null {
  const path = credentialsPath(system2Dir, provider);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as OAuthCredentials;
    if (
      typeof parsed.access !== 'string' ||
      typeof parsed.refresh !== 'string' ||
      typeof parsed.expires !== 'number' ||
      typeof parsed.label !== 'string'
    ) {
      log.warn(`[oauth-credentials] ${provider}.json missing required fields, ignoring`);
      return null;
    }
    return parsed;
  } catch (err) {
    log.warn(`[oauth-credentials] Failed to parse ${provider}.json:`, err);
    return null;
  }
}

export function saveOAuthCredentials(
  system2Dir: string,
  provider: LlmProvider,
  credentials: OAuthCredentials
): void {
  const dir = join(system2Dir, OAUTH_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(credentialsPath(system2Dir, provider), JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  });
}
