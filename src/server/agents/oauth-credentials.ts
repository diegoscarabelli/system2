import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTH_DIRNAME, type LlmProvider } from '../../shared/index.js';
import { log } from '../utils/logger.js';

/**
 * Pi-ai's OAuth credential shape. Returned by pi-ai's login() and refreshToken().
 */
export interface PiAiOAuthCredentials {
  access: string;
  refresh: string;
  /** Epoch ms when access token expires (already includes pi-ai's 5 min safety buffer). */
  expires: number;
  /** Provider-specific extras (e.g. Copilot's enterpriseDomain). Preserved
   *  through save/load and refresh so pi-ai's per-provider refresh handlers
   *  can rely on them. */
  [key: string]: unknown;
}

/**
 * System2's persisted OAuth credential shape: identical to pi-ai's. Older
 * versions added a `label` field, but OAuth credentials are stored one-per-
 * provider (`<provider>.json`) and the runtime never addressed them by label,
 * so the field was vestigial. Removed in 0.3.0. Existing on-disk files
 * containing `label` still load — the extra field is harmless and ignored.
 */
export type OAuthCredentials = PiAiOAuthCredentials;

function credentialsPath(system2Dir: string, provider: LlmProvider): string {
  return join(system2Dir, AUTH_DIRNAME, `${provider}.json`);
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
      typeof parsed.expires !== 'number'
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
  const dir = join(system2Dir, AUTH_DIRNAME);
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
