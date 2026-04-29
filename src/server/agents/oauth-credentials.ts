import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmProvider } from '../../shared/index.js';
import { log } from '../utils/logger.js';

export interface OAuthCredentials {
  access: string;
  refresh: string;
  /** Epoch ms when access token expires (already includes pi-ai's 5 min safety buffer). */
  expires: number;
  label: string;
  /** Provider-specific extras (projectId, email, enterpriseDomain). Preserved through
   *  save/load and refresh so pi-ai's per-provider refresh handlers can rely on them. */
  [key: string]: unknown;
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
  if (process.platform !== 'win32') {
    chmodSync(dir, 0o700); // idempotent; protects against loose perms on pre-existing dir
  }
  const finalPath = credentialsPath(system2Dir, provider);
  const data = JSON.stringify(credentials, null, 2);
  if (process.platform === 'win32') {
    // Windows rename can fail when the destination already exists; write directly
    // instead (sacrificing atomicity, which Windows file APIs don't reliably provide anyway).
    writeFileSync(finalPath, data, { mode: 0o600 });
  } else {
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, data, { mode: 0o600 });
    renameSync(tmpPath, finalPath);
  }
}
