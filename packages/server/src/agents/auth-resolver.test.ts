import type { LlmConfig } from '@system2/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthResolver } from './auth-resolver.js';

function makeConfig(overrides?: Partial<LlmConfig>): LlmConfig {
  return {
    primary: 'anthropic',
    fallback: ['openai'],
    providers: {
      anthropic: {
        keys: [
          { key: 'ant-key-1', label: 'main' },
          { key: 'ant-key-2', label: 'backup' },
        ],
      },
      openai: {
        keys: [{ key: 'oai-key-1', label: 'main' }],
      },
    },
    ...overrides,
  };
}

describe('AuthResolver', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws on invalid config', () => {
    expect(() => new AuthResolver({} as unknown as LlmConfig)).toThrow('Invalid LLM configuration');
  });

  it('returns primary provider', () => {
    const resolver = new AuthResolver(makeConfig());
    expect(resolver.primaryProvider).toBe('anthropic');
  });

  it('returns provider order (primary + fallback)', () => {
    const resolver = new AuthResolver(makeConfig());
    expect(resolver.providerOrder).toEqual(['anthropic', 'openai']);
  });

  it('returns first key as active by default', () => {
    const resolver = new AuthResolver(makeConfig());
    const active = resolver.getActiveKey('anthropic');
    expect(active).toEqual({ provider: 'anthropic', keyIndex: 0, label: 'main' });
  });

  it('returns undefined for unconfigured provider', () => {
    const resolver = new AuthResolver(makeConfig());
    expect(resolver.getActiveKey('google')).toBeUndefined();
  });

  describe('markKeyFailed', () => {
    it('marks auth failure as permanent and moves to next key', () => {
      const resolver = new AuthResolver(makeConfig());
      const hasMore = resolver.markKeyFailed('anthropic', 'auth');
      expect(hasMore).toBe(true);
      const active = resolver.getActiveKey('anthropic');
      expect(active?.keyIndex).toBe(1);
      expect(active?.label).toBe('backup');
    });

    it('falls back to next provider when all keys fail', () => {
      const resolver = new AuthResolver(makeConfig());
      resolver.markKeyFailed('anthropic', 'auth');
      resolver.markKeyFailed('anthropic', 'auth');
      // All anthropic keys failed, should find openai
      const next = resolver.getNextProvider();
      expect(next).toBe('openai');
    });

    it('returns false when all providers exhausted', () => {
      const resolver = new AuthResolver(makeConfig());
      resolver.markKeyFailed('anthropic', 'auth');
      resolver.markKeyFailed('anthropic', 'auth');
      const hasMore = resolver.markKeyFailed('openai', 'auth');
      expect(hasMore).toBe(false);
    });

    it('puts rate_limit failures in cooldown (not permanent)', () => {
      const resolver = new AuthResolver(makeConfig(), 1000);
      resolver.markKeyFailed('anthropic', 'rate_limit');
      // Key 0 in cooldown, should switch to key 1
      const active = resolver.getActiveKey('anthropic');
      expect(active?.keyIndex).toBe(1);
    });
  });

  describe('cooldown expiry', () => {
    it('restores keys after cooldown expires', () => {
      vi.useFakeTimers();
      const resolver = new AuthResolver(makeConfig(), 5000);
      resolver.markKeyFailed('anthropic', 'rate_limit');
      expect(resolver.getActiveKey('anthropic')?.keyIndex).toBe(1);

      // Advance past cooldown
      vi.advanceTimersByTime(6000);
      // Key 0 should be available again — but activeKeys still points to 0 initially,
      // so getting active key for a fresh lookup should find key 0
      const status = resolver.getStatus();
      expect(status.cooldowns).toHaveLength(0);
      vi.useRealTimers();
    });
  });

  describe('resetFailures', () => {
    it('clears all failures and cooldowns', () => {
      const resolver = new AuthResolver(makeConfig());
      resolver.markKeyFailed('anthropic', 'auth');
      resolver.markKeyFailed('openai', 'rate_limit');
      resolver.resetFailures();

      const status = resolver.getStatus();
      expect(status.failedKeys).toHaveLength(0);
      expect(status.cooldowns).toHaveLength(0);
      expect(status.activeProvider).toBe('anthropic');
    });
  });

  describe('getStatus', () => {
    it('returns current status', () => {
      const resolver = new AuthResolver(makeConfig());
      const status = resolver.getStatus();
      expect(status.primary).toBe('anthropic');
      expect(status.activeProvider).toBe('anthropic');
      expect(status.failedKeys).toHaveLength(0);
      expect(status.cooldowns).toHaveLength(0);
    });
  });

  describe('new providers', () => {
    it('works with mistral as primary', () => {
      const resolver = new AuthResolver(
        makeConfig({
          primary: 'mistral',
          fallback: ['anthropic'],
          providers: {
            mistral: { keys: [{ key: 'mist-key', label: 'default' }] },
            anthropic: { keys: [{ key: 'ant-key', label: 'default' }] },
          },
        })
      );
      expect(resolver.primaryProvider).toBe('mistral');
      expect(resolver.getActiveKey('mistral')).toEqual({
        provider: 'mistral',
        keyIndex: 0,
        label: 'default',
      });
    });

    it('fails over from groq to cerebras', () => {
      const resolver = new AuthResolver(
        makeConfig({
          primary: 'groq',
          fallback: ['cerebras'],
          providers: {
            groq: { keys: [{ key: 'gsk-key', label: 'default' }] },
            cerebras: { keys: [{ key: 'csk-key', label: 'default' }] },
          },
        })
      );
      resolver.markKeyFailed('groq', 'auth');
      const next = resolver.getNextProvider();
      expect(next).toBe('cerebras');
    });

    it('works with openai-compatible provider keys', () => {
      const resolver = new AuthResolver(
        makeConfig({
          primary: 'openai-compatible',
          fallback: [],
          providers: {
            'openai-compatible': {
              keys: [{ key: 'proxy-key', label: 'local' }],
              base_url: 'http://localhost:4000/v1',
              model: 'my-model',
            },
          },
        })
      );
      expect(resolver.primaryProvider).toBe('openai-compatible');
      expect(resolver.getActiveKey('openai-compatible')).toEqual({
        provider: 'openai-compatible',
        keyIndex: 0,
        label: 'local',
      });
    });
  });
});
