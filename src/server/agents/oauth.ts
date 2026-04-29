import { getOAuthProvider, type OAuthLoginCallbacks } from '@mariozechner/pi-ai/oauth';
import type { LlmProvider } from '../../shared/index.js';
import type { OAuthCredentials } from './oauth-credentials.js';

/** How close to expiry we trigger a refresh. pi-ai's expires already includes a 5min buffer; we add another 5. */
export const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export function isExpiringSoon(expires: number, bufferMs: number = REFRESH_BUFFER_MS): boolean {
  return Date.now() + bufferMs >= expires;
}

/**
 * Run the OAuth login flow for the given provider via pi-ai's registry.
 * Pi-ai handles the browser callback, PKCE, token exchange, and any provider-
 * specific post-processing (e.g., Antigravity's project-id discovery). Returned
 * credentials may include provider-specific extras (projectId, email,
 * enterpriseDomain); the open-shape OAuthCredentials preserves them through
 * save/load and refresh.
 */
export async function loginProvider(
  provider: LlmProvider,
  callbacks: OAuthLoginCallbacks
): Promise<OAuthCredentials> {
  const piProvider = getOAuthProvider(provider);
  if (!piProvider) {
    throw new Error(`OAuth provider "${provider}" is not registered with pi-ai`);
  }
  const creds = await piProvider.login(callbacks);
  return creds as OAuthCredentials;
}

/**
 * Refresh OAuth credentials for the given provider via pi-ai's registry.
 * Takes the full credential object so provider-specific extras (projectId, etc.)
 * survive the round-trip.
 */
export async function refreshOAuthToken(
  provider: LlmProvider,
  credentials: OAuthCredentials
): Promise<OAuthCredentials> {
  const piProvider = getOAuthProvider(provider);
  if (!piProvider) {
    throw new Error(`OAuth provider "${provider}" is not registered with pi-ai`);
  }
  const refreshed = await piProvider.refreshToken(credentials);
  return refreshed as OAuthCredentials;
}
