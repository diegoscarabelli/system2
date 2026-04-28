import { loginAnthropic, refreshAnthropicToken } from '@mariozechner/pi-ai/oauth';

/** How close to expiry we trigger a refresh. pi-ai's expires already includes a 5min buffer; we add another 5. */
export const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface RefreshedTokens {
  access: string;
  refresh: string;
  expires: number;
}

export function isExpiringSoon(expires: number, bufferMs: number = REFRESH_BUFFER_MS): boolean {
  return Date.now() + bufferMs >= expires;
}

/**
 * Refresh the Anthropic OAuth access token via the SDK.
 * Throws on network/auth failure.
 */
export async function refreshAnthropic(refreshToken: string): Promise<RefreshedTokens> {
  const updated = await refreshAnthropicToken(refreshToken);
  return {
    access: updated.access,
    refresh: updated.refresh,
    expires: updated.expires,
  };
}

export { loginAnthropic };
