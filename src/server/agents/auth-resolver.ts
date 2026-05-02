/**
 * Auth Resolver
 *
 * Manages API keys with failover support. Accepts LlmConfig from config.toml
 * and provides Pi SDK compatible AuthStorage with automatic key rotation on failure.
 *
 * Failover logic:
 * 1. Walk OAuth tier first (primary + fallback OAuth providers that have credentials)
 * 2. Only when every OAuth credential is in cooldown, drop to the API-keys tier
 * 3. Within the API-keys tier, try primary provider keys, then fallback providers in order
 * 4. Keys in cooldown recover after the cooldown period expires
 */

import { getOAuthProvider } from '@mariozechner/pi-ai/oauth';
import { AuthStorage } from '@mariozechner/pi-coding-agent';
import type { LlmConfig, LlmProvider } from '../../shared/index.js';
import { log } from '../utils/logger.js';
import { isExpiringSoon } from './oauth.js';
import type { OAuthCredentials, PiAiOAuthCredentials } from './oauth-credentials.js';

/** Default cooldown durations */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 90 * 1000;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

export type AuthTier = 'oauth' | 'api_keys';

export interface CooldownConfig {
  rateLimitMs: number;
  defaultMs: number;
}

export interface ActiveCredential {
  tier: AuthTier;
  provider: LlmProvider;
  keyIndex: number;
  label: string;
}

export type OAuthCredentialsMap = Partial<Record<LlmProvider, OAuthCredentials>>;

interface KeyCooldown {
  /** When the cooldown started */
  startTime: number;
  /** When the cooldown expires */
  expiresAt: number;
  /** Reason for cooldown */
  reason: 'auth' | 'rate_limit' | 'transient';
}

/**
 * Manages API key resolution with two-tier failover support.
 * OAuth tier (subscription credentials) is exhausted before falling over to the API key tier.
 */
export class AuthResolver {
  private config: LlmConfig;
  private activeKeys: Map<LlmProvider, number> = new Map();
  private cooldowns: Map<string, KeyCooldown> = new Map();
  private cooldownConfig: CooldownConfig;
  private oauthCredentials: OAuthCredentialsMap;
  private oauthOrder: LlmProvider[];
  private keysOrder: LlmProvider[];
  private persistCallbacks: Partial<
    Record<LlmProvider, (creds: OAuthCredentials) => Promise<void>>
  > = {};
  private refreshLocks: Map<LlmProvider, Promise<void>> = new Map();

  constructor(
    llmConfig: LlmConfig,
    cooldownConfig?: Partial<CooldownConfig>,
    oauthCredentials?: OAuthCredentialsMap
  ) {
    this.config = this.validateConfig(llmConfig);
    this.cooldownConfig = {
      rateLimitMs: cooldownConfig?.rateLimitMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
      defaultMs: cooldownConfig?.defaultMs ?? DEFAULT_COOLDOWN_MS,
    };
    this.oauthCredentials = oauthCredentials ?? {};

    this.oauthOrder = this.config.oauth
      ? [this.config.oauth.primary, ...this.config.oauth.fallback].filter(
          (p) => this.oauthCredentials[p] !== undefined
        )
      : [];
    this.keysOrder = [this.config.primary, ...this.config.fallback];

    // Initialize active key index to 0 for each provider with keys
    for (const provider of Object.keys(this.config.providers) as LlmProvider[]) {
      if (this.config.providers[provider]) {
        this.activeKeys.set(provider, 0);
      }
    }
  }

  /**
   * Validate the LLM configuration structure.
   */
  private validateConfig(config: LlmConfig): LlmConfig {
    if (!config.primary || !config.providers) {
      throw new Error('Invalid LLM configuration. Run "system2 config" to reconfigure.');
    }
    return config;
  }

  /**
   * Check if a key is currently unavailable (in cooldown).
   */
  private isKeyUnavailable(keyId: string): boolean {
    const cooldown = this.cooldowns.get(keyId);
    if (cooldown) {
      if (Date.now() >= cooldown.expiresAt) {
        this.cooldowns.delete(keyId);
        log.info(`[AuthResolver] Cooldown expired for ${keyId}, key available again`);
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Build a namespaced cooldown key that includes the tier so OAuth and keys
   * cooldowns for the same provider/index do not collide.
   */
  private cooldownKey(tier: AuthTier, provider: LlmProvider, keyIndex: number): string {
    return `${tier}:${provider}:${keyIndex}`;
  }

  /**
   * Get the primary provider (OAuth tier's primary if configured, else keys tier primary).
   */
  get primaryProvider(): LlmProvider {
    return this.oauthOrder[0] ?? this.config.primary;
  }

  /**
   * Get ordered list of providers to try (OAuth tier first, then keys tier), deduplicated.
   */
  get providerOrder(): LlmProvider[] {
    const seen = new Set<LlmProvider>();
    const out: LlmProvider[] = [];
    for (const p of [...this.oauthOrder, ...this.keysOrder]) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out;
  }

  /**
   * Walk OAuth tier first, then keys tier, returning the first credential not in cooldown.
   */
  getActiveCredential(): ActiveCredential | undefined {
    // OAuth tier
    for (const provider of this.oauthOrder) {
      const cred = this.oauthCredentials[provider];
      if (!cred) continue;
      if (this.isKeyUnavailable(this.cooldownKey('oauth', provider, 0))) continue;
      return { tier: 'oauth', provider, keyIndex: 0, label: cred.label };
    }
    // Keys tier
    for (const provider of this.keysOrder) {
      const providerConfig = this.config.providers[provider];
      if (!providerConfig) continue;
      for (let i = 0; i < providerConfig.keys.length; i++) {
        const key = providerConfig.keys[i];
        if (key.key && !this.isKeyUnavailable(this.cooldownKey('api_keys', provider, i))) {
          this.activeKeys.set(provider, i);
          return { tier: 'api_keys', provider, keyIndex: i, label: key.label };
        }
      }
    }
    return undefined;
  }

  /**
   * Get the currently active credential for a provider.
   *
   * When tier is not specified, tries OAuth first, then keys (for the given provider only).
   * When tier is specified, restricts to that tier.
   */
  getActiveKey(provider: LlmProvider, tier?: AuthTier): ActiveCredential | undefined {
    const tryOAuth = (): ActiveCredential | undefined => {
      if (!this.oauthOrder.includes(provider)) return undefined;
      const cred = this.oauthCredentials[provider];
      if (!cred) return undefined;
      if (this.isKeyUnavailable(this.cooldownKey('oauth', provider, 0))) return undefined;
      return { tier: 'oauth', provider, keyIndex: 0, label: cred.label };
    };

    const tryKeys = (): ActiveCredential | undefined => {
      const providerConfig = this.config.providers[provider];
      if (!providerConfig) return undefined;
      const index = this.activeKeys.get(provider) ?? 0;
      // Check current index first
      const currentKeyId = this.cooldownKey('api_keys', provider, index);
      if (!this.isKeyUnavailable(currentKeyId)) {
        const key = providerConfig.keys[index];
        if (key?.key) {
          return { tier: 'api_keys', provider, keyIndex: index, label: key.label };
        }
      }
      // Current index unavailable, find next valid
      for (let i = 0; i < providerConfig.keys.length; i++) {
        const key = providerConfig.keys[i];
        const keyId = this.cooldownKey('api_keys', provider, i);
        if (key.key && !this.isKeyUnavailable(keyId)) {
          this.activeKeys.set(provider, i);
          return { tier: 'api_keys', provider, keyIndex: i, label: key.label };
        }
      }
      return undefined;
    };

    if (tier === 'oauth') return tryOAuth();
    if (tier === 'api_keys') return tryKeys();
    return tryOAuth() ?? tryKeys();
  }

  /**
   * Check if a specific key is currently in cooldown.
   * Used by AgentHost to detect when another agent has already put its key in cooldown.
   *
   * @param tier - defaults to 'api_keys' for backward compatibility
   */
  isKeyInCooldown(provider: LlmProvider, keyIndex: number, tier: AuthTier = 'api_keys'): boolean {
    return this.isKeyUnavailable(this.cooldownKey(tier, provider, keyIndex));
  }

  /**
   * Mark a specific key for a provider as failed.
   * All failures use cooldown so the system recovers if the user fixes the issue.
   *
   * @param provider - The provider whose key failed
   * @param reason - Why it failed (determines cooldown duration for rate_limit)
   * @param errorMessage - Original API error message for logging
   * @param keyIndex - The specific key index that failed (avoids stale global state when multiple agents share the resolver)
   * @param tier - Which tier the key belongs to (defaults to 'api_keys' for backward compatibility)
   * @returns true if there's a fallback available (next key or next provider)
   */
  markKeyFailed(
    provider: LlmProvider,
    reason: 'auth' | 'rate_limit' | 'transient' = 'transient',
    errorMessage?: string,
    keyIndex?: number,
    tier: AuthTier = 'api_keys'
  ): boolean {
    const currentIndex = keyIndex ?? this.activeKeys.get(provider) ?? 0;
    const keyId = this.cooldownKey(tier, provider, currentIndex);

    if (!this.cooldowns.has(keyId)) {
      const now = Date.now();
      const duration =
        reason === 'rate_limit' ? this.cooldownConfig.rateLimitMs : this.cooldownConfig.defaultMs;
      this.cooldowns.set(keyId, {
        startTime: now,
        expiresAt: now + duration,
        reason,
      });
      const detail = errorMessage ? `: ${errorMessage}` : '';
      log.info(`[AuthResolver] Key in cooldown: ${keyId}, expires in ${duration / 1000}s${detail}`);
    } else {
      log.info(`[AuthResolver] Key ${keyId} already in cooldown, skipping`);
    }

    // Walk forward through tiers/providers/keys to confirm something is still available
    return this.getActiveCredential() !== undefined;
  }

  /**
   * Get the next provider to try after failure.
   * Returns undefined if no providers are available.
   */
  getNextProvider(): LlmProvider | undefined {
    return this.getActiveCredential()?.provider;
  }

  /**
   * Reset all cooldowns.
   */
  resetFailures(): void {
    this.cooldowns.clear();
    // Reset to first key for each provider
    for (const provider of Object.keys(this.config.providers) as LlmProvider[]) {
      if (this.config.providers[provider]) {
        this.activeKeys.set(provider, 0);
      }
    }
    log.info('[AuthResolver] All failures and cooldowns reset');
  }

  /**
   * Clear cooldowns that were set for transient errors (client-error and server-error
   * categories). Auth and rate-limit cooldowns are preserved.
   *
   * Used as a last resort when all providers are exhausted due to 400 errors that may
   * have been context overflow misclassified as client errors. Clearing only transient
   * cooldowns is safe: auth failures should remain blocked, and rate-limit cooldowns
   * should remain to respect provider backoff windows.
   */
  clearTransientCooldowns(): void {
    for (const [keyId, cooldown] of this.cooldowns) {
      if (cooldown.reason === 'transient') {
        this.cooldowns.delete(keyId);
        log.info(`[AuthResolver] Cleared transient cooldown for ${keyId}`);
      }
    }
  }

  /**
   * Clear expired cooldowns and check if any keys are available again.
   */
  clearExpiredCooldowns(): void {
    const now = Date.now();
    for (const [keyId, cooldown] of this.cooldowns) {
      if (now >= cooldown.expiresAt) {
        this.cooldowns.delete(keyId);
        log.info(`[AuthResolver] Cooldown expired for ${keyId}`);
      }
    }
  }

  /**
   * Create a Pi SDK AuthStorage with current active keys.
   * For providers in the OAuth tier, uses the OAuth access token.
   * For providers in the keys tier, uses the API key.
   */
  createAuthStorage(): AuthStorage {
    const data: Record<string, { type: 'api_key'; key: string }> = {};

    const providersInScope = new Set<LlmProvider>([...this.oauthOrder, ...this.keysOrder]);
    for (const provider of providersInScope) {
      const active = this.getActiveKey(provider);
      if (!active) continue;
      let keyValue: string | undefined;
      if (active.tier === 'oauth') {
        const creds = this.oauthCredentials[provider];
        if (creds) {
          // Delegate to pi-ai's OAuth provider so per-provider wire formats are
          // honored (anthropic/copilot/codex pass `access` through; gemini-cli and
          // antigravity wrap as JSON {token, projectId}).
          const piProvider = getOAuthProvider(provider);
          keyValue = piProvider ? piProvider.getApiKey(creds) : creds.access;
        }
      } else {
        keyValue = this.config.providers[provider]?.keys[active.keyIndex]?.key;
      }
      if (keyValue) {
        data[provider] = { type: 'api_key', key: keyValue };
      }
    }

    return AuthStorage.inMemory(data);
  }

  /**
   * Register a callback that persists refreshed OAuth credentials for a provider.
   */
  setPersistOAuth(
    provider: LlmProvider,
    callback: (creds: OAuthCredentials) => Promise<void>
  ): void {
    this.persistCallbacks[provider] = callback;
  }

  /**
   * Refresh any OAuth credential whose access token is within the expiry buffer.
   * Returns the set of providers whose credentials were refreshed; callers should
   * reinitialize SDK sessions for those providers (existing sessions hold a snapshot
   * of the old access token).
   * Concurrent callers are serialized per provider so refresh runs once.
   *
   * @param deps.force - Providers to refresh regardless of expiry (e.g., on 401 from a
   *   revoked-but-not-expired token). Defaults to empty — only expiry-based refresh occurs.
   */
  async ensureFresh(deps: {
    refresh: (
      provider: LlmProvider,
      credentials: OAuthCredentials
    ) => Promise<PiAiOAuthCredentials>;
    /** Providers to refresh regardless of expiry (e.g., on 401 from a revoked-but-not-expired token). */
    force?: LlmProvider[];
  }): Promise<Set<LlmProvider>> {
    const refreshed = new Set<LlmProvider>();
    const forceSet = new Set(deps.force ?? []);
    for (const provider of this.oauthOrder) {
      const cred = this.oauthCredentials[provider];
      if (!cred) continue;
      const shouldRefresh = forceSet.has(provider) || isExpiringSoon(cred.expires);
      if (!shouldRefresh) continue;

      const existing = this.refreshLocks.get(provider);
      // Bug B fix: re-read credential after awaiting so we use the rotated refresh token.
      let credToUse = cred;
      if (existing) {
        await existing;
        const after = this.oauthCredentials[provider];
        if (!after) continue; // credential disappeared while we waited
        const stillNeedsRefresh = forceSet.has(provider) || isExpiringSoon(after.expires);
        if (!stillNeedsRefresh) {
          refreshed.add(provider);
          continue;
        }
        credToUse = after;
      }

      const lock = this.doRefresh(provider, credToUse, deps.refresh).finally(() => {
        this.refreshLocks.delete(provider);
      });
      this.refreshLocks.set(provider, lock);
      await lock;
      refreshed.add(provider);
    }
    return refreshed;
  }

  /**
   * Get the current in-memory OAuth credential for a provider.
   * Used for inspection and testing.
   */
  getActiveOAuthCredential(provider: LlmProvider): OAuthCredentials | undefined {
    return this.oauthCredentials[provider];
  }

  private async doRefresh(
    provider: LlmProvider,
    cred: OAuthCredentials,
    refresh: (provider: LlmProvider, credentials: OAuthCredentials) => Promise<PiAiOAuthCredentials>
  ): Promise<void> {
    const updated = await refresh(provider, cred);
    // Defensive merge: start with the old credential (preserves provider-
    // specific extras like Copilot's enterpriseDomain), overlay the refreshed
    // fields (typically access/refresh/expires plus any extras pi-ai chose to
    // return), then explicitly preserve label (set during login, not by
    // pi-ai's refresh).
    const merged: OAuthCredentials = { ...cred, ...updated, label: cred.label };
    this.oauthCredentials[provider] = merged;
    // Clear any cooldown left over from a 401 on the now-superseded credential.
    // Without this, a successfully refreshed credential is still treated as
    // unavailable by getActiveKey / createAuthStorage until the original
    // cooldown expires (~5 min). The downstream symptom: AgentHost.reinit
    // rebuilds an AuthStorage with no entry for `provider`, and pi-coding-agent
    // throws "No API key found for <provider>" — even though the new token is
    // healthy on disk and in memory. The cooldown was set to penalise the OLD
    // token; the refreshed token deserves a clean slate.
    this.cooldowns.delete(this.cooldownKey('oauth', provider, 0));
    log.info(`[AuthResolver] OAuth token refreshed for ${provider}:${cred.label}`);

    const persist = this.persistCallbacks[provider];
    if (persist) {
      try {
        await persist(merged);
      } catch (err) {
        log.warn(`[AuthResolver] Failed to persist refreshed OAuth for ${provider}:`, err);
      }
    }
  }

  /**
   * Get current status for logging/debugging.
   */
  getStatus(): {
    primary: LlmProvider;
    activeProvider: LlmProvider | undefined;
    cooldowns: { keyId: string; reason: string; expiresIn: number }[];
  } {
    // Clear expired cooldowns first
    this.clearExpiredCooldowns();

    const cooldownInfo = Array.from(this.cooldowns.entries()).map(([keyId, cooldown]) => ({
      keyId,
      reason: cooldown.reason,
      expiresIn: Math.max(0, Math.round((cooldown.expiresAt - Date.now()) / 1000)),
    }));

    return {
      primary: this.config.primary,
      activeProvider: this.getNextProvider(),
      cooldowns: cooldownInfo,
    };
  }
}
