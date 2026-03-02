/**
 * Auth Resolver
 *
 * Manages API keys with failover support. Reads System2's auth.json format
 * and provides Pi SDK compatible AuthStorage with automatic key rotation on failure.
 *
 * Failover logic:
 * 1. Try keys for primary provider in order
 * 2. If all primary keys fail, try fallback providers in order
 * 3. Each provider's keys are tried in order until one works
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AuthStorage } from '@mariozechner/pi-coding-agent';

const SYSTEM2_DIR = join(homedir(), '.system2');
const AUTH_FILE = join(SYSTEM2_DIR, 'auth.json');

type Provider = 'anthropic' | 'openai' | 'google';

interface AuthKey {
  key: string;
  label: string;
}

interface ProviderKeys {
  keys: AuthKey[];
}

interface AuthConfig {
  version: 1;
  primary: Provider;
  fallback: Provider[];
  providers: Record<Provider, ProviderKeys>;
}

interface ActiveKey {
  provider: Provider;
  keyIndex: number;
  label: string;
}

/**
 * Manages API key resolution with failover support.
 */
export class AuthResolver {
  private config: AuthConfig;
  private activeKeys: Map<Provider, number> = new Map(); // Provider -> current key index
  private failedKeys: Set<string> = new Set(); // "provider:index" for failed keys

  constructor(authPath: string = AUTH_FILE) {
    this.config = this.loadConfig(authPath);

    // Initialize active key index to 0 for each provider with keys
    for (const provider of Object.keys(this.config.providers) as Provider[]) {
      this.activeKeys.set(provider, 0);
    }
  }

  private loadConfig(authPath: string): AuthConfig {
    if (!existsSync(authPath)) {
      throw new Error(`Auth file not found: ${authPath}. Run 'system2 onboard' first.`);
    }

    const content = readFileSync(authPath, 'utf-8');
    const config = JSON.parse(content);

    // Validate structure
    if (!config.version || !config.primary || !config.providers) {
      throw new Error('Invalid auth.json format. Run "system2 onboard" to reconfigure.');
    }

    return config as AuthConfig;
  }

  /**
   * Get the primary provider.
   */
  get primaryProvider(): Provider {
    return this.config.primary;
  }

  /**
   * Get ordered list of providers to try (primary first, then fallbacks).
   */
  get providerOrder(): Provider[] {
    return [this.config.primary, ...this.config.fallback];
  }

  /**
   * Get the first valid key for a provider.
   */
  private getFirstValidKey(provider: Provider): AuthKey | undefined {
    const providerConfig = this.config.providers[provider];
    if (!providerConfig) return undefined;

    // Find first non-empty, non-failed key
    for (let i = 0; i < providerConfig.keys.length; i++) {
      const key = providerConfig.keys[i];
      const failedId = `${provider}:${i}`;

      if (key.key && !this.failedKeys.has(failedId)) {
        this.activeKeys.set(provider, i);
        return key;
      }
    }

    return undefined;
  }

  /**
   * Get the currently active key for a provider.
   */
  getActiveKey(provider: Provider): ActiveKey | undefined {
    const index = this.activeKeys.get(provider) ?? 0;
    const providerConfig = this.config.providers[provider];

    if (!providerConfig) return undefined;

    // Check if current index is valid and not failed
    const failedId = `${provider}:${index}`;
    if (this.failedKeys.has(failedId)) {
      // Current key failed, find next valid
      const nextKey = this.getFirstValidKey(provider);
      if (!nextKey) return undefined;
      return {
        provider,
        keyIndex: this.activeKeys.get(provider)!,
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
   * Mark the current key for a provider as failed.
   * Returns true if there's a fallback available (next key or next provider).
   */
  markKeyFailed(provider: Provider): boolean {
    const currentIndex = this.activeKeys.get(provider) ?? 0;
    this.failedKeys.add(`${provider}:${currentIndex}`);

    console.log(`[AuthResolver] Key failed: ${provider}:${currentIndex}`);

    // Try to find next valid key for this provider
    const nextKey = this.getFirstValidKey(provider);
    if (nextKey) {
      console.log(`[AuthResolver] Switching to next key for ${provider}`);
      return true;
    }

    // No more keys for this provider, check if there are fallback providers
    const currentProviderIndex = this.providerOrder.indexOf(provider);
    for (let i = currentProviderIndex + 1; i < this.providerOrder.length; i++) {
      const fallbackProvider = this.providerOrder[i];
      const fallbackKey = this.getFirstValidKey(fallbackProvider);
      if (fallbackKey) {
        console.log(`[AuthResolver] Falling back to provider: ${fallbackProvider}`);
        return true;
      }
    }

    console.log('[AuthResolver] No more fallback keys available');
    return false;
  }

  /**
   * Get the next provider to try after failure.
   * Returns undefined if no providers are available.
   */
  getNextProvider(): Provider | undefined {
    for (const provider of this.providerOrder) {
      const key = this.getActiveKey(provider);
      if (key) {
        return provider;
      }
    }
    return undefined;
  }

  /**
   * Reset all failed keys (e.g., after a cooldown period).
   */
  resetFailures(): void {
    this.failedKeys.clear();
    // Reset to first key for each provider
    for (const provider of Object.keys(this.config.providers) as Provider[]) {
      this.activeKeys.set(provider, 0);
    }
  }

  /**
   * Create a Pi SDK AuthStorage with current active keys.
   * The AuthStorage will have one key per provider (the currently active one).
   */
  createAuthStorage(): AuthStorage {
    const data: Record<string, { type: 'api_key'; key: string }> = {};

    for (const provider of Object.keys(this.config.providers) as Provider[]) {
      const activeKey = this.getActiveKey(provider);
      if (activeKey) {
        const key = this.config.providers[provider].keys[activeKey.keyIndex];
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
    primary: Provider;
    activeProvider: Provider | undefined;
    failedKeys: string[];
  } {
    return {
      primary: this.config.primary,
      activeProvider: this.getNextProvider(),
      failedKeys: Array.from(this.failedKeys),
    };
  }
}
