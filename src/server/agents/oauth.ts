import { getOAuthProvider, type OAuthLoginCallbacks } from '@mariozechner/pi-ai/oauth';
import type { LlmProvider } from '../../shared/index.js';
import type { OAuthCredentials, PiAiOAuthCredentials } from './oauth-credentials.js';

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
 * enterpriseDomain); the open-shape preserves them through save/load and refresh.
 *
 * Returns PiAiOAuthCredentials (not OAuthCredentials) because pi-ai's login does
 * NOT assign the human-readable `label` field — that's set by the CLI at save
 * time. Callers must add `label` before calling saveOAuthCredentials.
 */
export async function loginProvider(
  provider: LlmProvider,
  callbacks: OAuthLoginCallbacks
): Promise<PiAiOAuthCredentials> {
  const piProvider = getOAuthProvider(provider);
  if (!piProvider) {
    throw new Error(`OAuth provider "${provider}" is not registered with pi-ai`);
  }
  const creds = await piProvider.login(callbacks);
  return creds as PiAiOAuthCredentials;
}

/**
 * Refresh OAuth credentials for the given provider via pi-ai's registry.
 * Takes the full credential object so provider-specific extras (projectId, etc.)
 * survive the round-trip.
 *
 * Returns PiAiOAuthCredentials (label-less) for the same reason as loginProvider:
 * pi-ai's refreshToken doesn't return the label. AuthResolver.doRefresh restores
 * the label from the old credential before persisting (see the merge at
 * auth-resolver.ts), so the on-disk credential keeps its label.
 */
export async function refreshOAuthToken(
  provider: LlmProvider,
  credentials: OAuthCredentials
): Promise<PiAiOAuthCredentials> {
  const piProvider = getOAuthProvider(provider);
  if (!piProvider) {
    throw new Error(`OAuth provider "${provider}" is not registered with pi-ai`);
  }
  const refreshed = await piProvider.refreshToken(credentials);
  return refreshed as PiAiOAuthCredentials;
}
