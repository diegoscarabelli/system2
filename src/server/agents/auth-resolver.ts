/**
 * Auth Resolver
 *
 * Manages API keys with failover support. Accepts LlmConfig from config.toml
 * and provides Pi SDK compatible AuthStorage with automatic key rotation on failure.
 *
 * Failover logic:
 * 1. Try keys for primary provider in order
 * 2. If all primary keys fail, try fallback providers in order
 * 3. Each provider's keys are tried in order until one works
 * 4. Keys in cooldown recover after the cooldown period expires
 */

import { AuthStorage } from '@mariozechner/pi-coding-agent';
import type { LlmConfig, LlmKey, LlmProvider } from '../../shared/index.js';
import { log } from '../utils/logger.js';

/** Default cooldown durations */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 90 * 1000;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

export interface CooldownConfig {
  rateLimitMs: number;
  defaultMs: number;
}

export interface ActiveKey {
  provider: LlmProvider;
  keyIndex: number;
  label: string;
}

interface KeyCooldown {
  /** When the cooldown started */
  startTime: number;
  /** When the cooldown expires */
  expiresAt: number;
  /** Reason for cooldown */
  reason: 'auth' | 'rate_limit' | 'transient';
}

/**
 * Manages API key resolution with failover support.
 */
export class AuthResolver {
  private config: LlmConfig;
  private activeKeys: Map<LlmProvider, number> = new Map();
  private cooldowns: Map<string, KeyCooldown> = new Map();
  private cooldownConfig: CooldownConfig;

  constructor(llmConfig: LlmConfig, cooldownConfig?: Partial<CooldownConfig>) {
    this.config = this.validateConfig(llmConfig);
    this.cooldownConfig = {
      rateLimitMs: cooldownConfig?.rateLimitMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
      defaultMs: cooldownConfig?.defaultMs ?? DEFAULT_COOLDOWN_MS,
    };

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
      throw new Error('Invalid LLM configuration. Run "system2 onboard" to reconfigure.');
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
   * Get the primary provider.
   */
  get primaryProvider(): LlmProvider {
    return this.config.primary;
  }

  /**
   * Get ordered list of providers to try (primary first, then fallbacks).
   */
  get providerOrder(): LlmProvider[] {
    return [this.config.primary, ...this.config.fallback];
  }

  /**
   * Get the first valid key for a provider.
   */
  private getFirstValidKey(provider: LlmProvider): LlmKey | undefined {
    const providerConfig = this.config.providers[provider];
    if (!providerConfig) return undefined;

    // Find first non-empty, available key (not failed or in cooldown)
    for (let i = 0; i < providerConfig.keys.length; i++) {
      const key = providerConfig.keys[i];
      const keyId = `${provider}:${i}`;

      if (key.key && !this.isKeyUnavailable(keyId)) {
        this.activeKeys.set(provider, i);
        return key;
      }
    }

    return undefined;
  }

  /**
   * Get the currently active key for a provider.
   */
  getActiveKey(provider: LlmProvider): ActiveKey | undefined {
    const index = this.activeKeys.get(provider) ?? 0;
    const providerConfig = this.config.providers[provider];

    if (!providerConfig) return undefined;

    // Check if current index is valid and available
    const keyId = `${provider}:${index}`;
    if (this.isKeyUnavailable(keyId)) {
      // Current key unavailable, find next valid
      const nextKey = this.getFirstValidKey(provider);
      if (!nextKey) return undefined;
      // getFirstValidKey sets activeKeys, so this will always have a value
      const newIndex = this.activeKeys.get(provider) ?? 0;
      return {
        provider,
        keyIndex: newIndex,
        label: nextKey.label,
      };
    }

    const key = providerConfig.keys[index];
    if (!key || !key.key) return undefined;

    return {
      provider,
      keyIndex: index,
      label: key.label,
    };
  }

  /**
   * Check if a specific key is currently in cooldown.
   * Used by AgentHost to detect when another agent has already put its key in cooldown.
   */
  isKeyInCooldown(provider: LlmProvider, keyIndex: number): boolean {
    return this.isKeyUnavailable(`${provider}:${keyIndex}`);
  }

  /**
   * Mark a specific key for a provider as failed.
   * All failures use cooldown so the system recovers if the user fixes the issue.
   *
   * @param provider - The provider whose key failed
   * @param reason - Why it failed (determines cooldown duration for rate_limit)
   * @param errorMessage - Original API error message for logging
   * @param keyIndex - The specific key index that failed (avoids stale global state when multiple agents share the resolver)
   * @returns true if there's a fallback available (next key or next provider)
   */
  markKeyFailed(
    provider: LlmProvider,
    reason: 'auth' | 'rate_limit' | 'transient' = 'transient',
    errorMessage?: string,
    keyIndex?: number
  ): boolean {
    const currentIndex = keyIndex ?? this.activeKeys.get(provider) ?? 0;
    const keyId = `${provider}:${currentIndex}`;

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

    // Try to find next valid key for this provider
    const nextKey = this.getFirstValidKey(provider);
    if (nextKey) {
      log.info(`[AuthResolver] Switching to next key for ${provider}`);
      return true;
    }

    // No more keys for this provider, check if there are fallback providers
    const currentProviderIndex = this.providerOrder.indexOf(provider);
    for (let i = currentProviderIndex + 1; i < this.providerOrder.length; i++) {
      const fallbackProvider = this.providerOrder[i];
      const fallbackKey = this.getFirstValidKey(fallbackProvider);
      if (fallbackKey) {
        log.info(`[AuthResolver] Falling back to provider: ${fallbackProvider}`);
        return true;
      }
    }

    log.info('[AuthResolver] No more fallback keys available');
    return false;
  }

  /**
   * Get the next provider to try after failure.
   * Returns undefined if no providers are available.
   */
  getNextProvider(): LlmProvider | undefined {
    for (const provider of this.providerOrder) {
      const key = this.getActiveKey(provider);
      if (key) {
        return provider;
      }
    }
    return undefined;
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
   * The AuthStorage will have one key per provider (the currently active one).
   */
  createAuthStorage(): AuthStorage {
    const data: Record<string, { type: 'api_key'; key: string }> = {};

    for (const provider of Object.keys(this.config.providers) as LlmProvider[]) {
      const providerConfig = this.config.providers[provider];
      if (!providerConfig) continue;

      const activeKey = this.getActiveKey(provider);
      if (activeKey) {
        const key = providerConfig.keys[activeKey.keyIndex];
        if (key?.key) {
          data[provider] = { type: 'api_key', key: key.key };
        }
      }
    }

    return AuthStorage.inMemory(data);
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
