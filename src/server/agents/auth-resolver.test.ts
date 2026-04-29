import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmConfig, LlmProvider } from '../../shared/index.js';
import { AuthResolver } from './auth-resolver.js';
import type { OAuthCredentials } from './oauth-credentials.js';

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
    expect(active).toEqual({ tier: 'keys', provider: 'anthropic', keyIndex: 0, label: 'main' });
  });

  it('returns undefined for unconfigured provider', () => {
    const resolver = new AuthResolver(makeConfig());
    expect(resolver.getActiveKey('google')).toBeUndefined();
  });

  describe('markKeyFailed', () => {
    it('puts auth failure in cooldown and moves to next key', () => {
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
      const resolver = new AuthResolver(makeConfig(), { rateLimitMs: 1000 });
      resolver.markKeyFailed('anthropic', 'rate_limit');
      // Key 0 in cooldown, should switch to key 1
      const active = resolver.getActiveKey('anthropic');
      expect(active?.keyIndex).toBe(1);
    });

    it('uses shorter cooldown for rate_limit than transient', () => {
      vi.useFakeTimers();
      const resolver = new AuthResolver(makeConfig(), { rateLimitMs: 2000, defaultMs: 10000 });

      resolver.markKeyFailed('anthropic', 'rate_limit');
      // Key 0 in cooldown, key 1 active
      expect(resolver.getActiveKey('anthropic')?.keyIndex).toBe(1);

      // After 3s, rate_limit cooldown (2s) should have expired
      vi.advanceTimersByTime(3000);
      const status = resolver.getStatus();
      expect(status.cooldowns).toHaveLength(0);

      vi.useRealTimers();
    });

    it('uses longer cooldown for transient errors', () => {
      vi.useFakeTimers();
      const resolver = new AuthResolver(makeConfig(), { rateLimitMs: 2000, defaultMs: 10000 });

      resolver.markKeyFailed('anthropic', 'transient');
      expect(resolver.getActiveKey('anthropic')?.keyIndex).toBe(1);

      // After 3s, transient cooldown (10s) should still be active
      vi.advanceTimersByTime(3000);
      const status = resolver.getStatus();
      expect(status.cooldowns).toHaveLength(1);

      vi.useRealTimers();
    });

    it('does not reset cooldown if key is already in cooldown', () => {
      vi.useFakeTimers();
      // Use a single-key provider so activeKeys stays at 0 after first failure
      const resolver = new AuthResolver(
        makeConfig({
          primary: 'openai',
          fallback: [],
          providers: {
            openai: { keys: [{ key: 'oai-key-1', label: 'main' }] },
          },
        }),
        { rateLimitMs: 5000, defaultMs: 5000 }
      );

      resolver.markKeyFailed('openai', 'rate_limit');

      // Advance 3s, then mark same key failed again (simulates a second agent)
      vi.advanceTimersByTime(3000);
      resolver.markKeyFailed('openai', 'rate_limit');

      // Cooldown should still expire at original time (5s from start), not reset to 5s from now
      // At 3s elapsed, 2s remaining from original cooldown
      vi.advanceTimersByTime(2500);
      const status = resolver.getStatus();
      expect(status.cooldowns).toHaveLength(0);

      vi.useRealTimers();
    });
  });

  describe('isKeyInCooldown', () => {
    it('returns true for a key in cooldown', () => {
      const resolver = new AuthResolver(makeConfig());
      resolver.markKeyFailed('anthropic', 'rate_limit', undefined, 0);
      expect(resolver.isKeyInCooldown('anthropic', 0)).toBe(true);
      expect(resolver.isKeyInCooldown('anthropic', 1)).toBe(false);
    });
  });

  describe('markKeyFailed with explicit keyIndex', () => {
    it('marks the specified key, not the global active index', () => {
      const resolver = new AuthResolver(makeConfig());

      // Simulate Agent A rotating from key 0 to key 1
      resolver.markKeyFailed('anthropic', 'rate_limit', undefined, 0);
      expect(resolver.getActiveKey('anthropic')?.keyIndex).toBe(1);

      // Simulate Agent B (still using key 0) reporting the same failure.
      // Without explicit keyIndex, this would mark key 1 (the current active).
      // With explicit keyIndex=0, it should be a no-op (already in cooldown).
      resolver.markKeyFailed('anthropic', 'rate_limit', undefined, 0);
      // Key 1 should NOT be in cooldown
      expect(resolver.isKeyInCooldown('anthropic', 1)).toBe(false);
      expect(resolver.getActiveKey('anthropic')?.keyIndex).toBe(1);
    });
  });

  describe('cooldown expiry', () => {
    it('restores keys after cooldown expires', () => {
      vi.useFakeTimers();
      const resolver = new AuthResolver(makeConfig(), { rateLimitMs: 5000 });
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
    it('clears all cooldowns', () => {
      const resolver = new AuthResolver(makeConfig());
      resolver.markKeyFailed('anthropic', 'auth');
      resolver.markKeyFailed('openai', 'rate_limit');
      resolver.resetFailures();

      const status = resolver.getStatus();
      expect(status.cooldowns).toHaveLength(0);
      expect(status.activeProvider).toBe('anthropic');
    });
  });

  describe('clearTransientCooldowns', () => {
    it('clears transient cooldowns but preserves auth and rate_limit cooldowns', () => {
      const resolver = new AuthResolver(makeConfig());
      resolver.markKeyFailed('anthropic', 'transient');
      resolver.markKeyFailed('openai', 'auth');
      resolver.clearTransientCooldowns();

      const status = resolver.getStatus();
      // Only the auth cooldown remains
      expect(status.cooldowns).toHaveLength(1);
      expect(status.cooldowns[0].reason).toBe('auth');
    });

    it('restores provider availability after clearing transient cooldowns', () => {
      const resolver = new AuthResolver(makeConfig());
      // Exhaust all keys with transient failures
      resolver.markKeyFailed('anthropic', 'transient', undefined, 0);
      resolver.markKeyFailed('anthropic', 'transient', undefined, 1);
      resolver.markKeyFailed('openai', 'transient', undefined, 0);
      expect(resolver.getNextProvider()).toBeUndefined();

      resolver.clearTransientCooldowns();
      expect(resolver.getNextProvider()).toBe('anthropic');
    });

    it('is a no-op when there are no transient cooldowns', () => {
      const resolver = new AuthResolver(makeConfig());
      resolver.markKeyFailed('anthropic', 'auth');
      resolver.clearTransientCooldowns();

      const status = resolver.getStatus();
      expect(status.cooldowns).toHaveLength(1);
      expect(status.cooldowns[0].reason).toBe('auth');
    });
  });

  describe('getStatus', () => {
    it('returns current status', () => {
      const resolver = new AuthResolver(makeConfig());
      const status = resolver.getStatus();
      expect(status.primary).toBe('anthropic');
      expect(status.activeProvider).toBe('anthropic');
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
        tier: 'keys',
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
        tier: 'keys',
        provider: 'openai-compatible',
        keyIndex: 0,
        label: 'local',
      });
    });
  });
});

function makeTwoTierConfig(): LlmConfig {
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
      openai: { keys: [{ key: 'oai-key-1', label: 'main' }] },
    },
    oauth: { primary: 'anthropic', fallback: [] },
  };
}

function makeOAuthCreds(expiresInMs: number = 60 * 60_000): OAuthCredentials {
  return {
    access: 'sk-ant-oat-abc',
    refresh: 'rt-xyz',
    expires: Date.now() + expiresInMs,
    label: 'claude-pro',
  };
}

describe('AuthResolver — two-tier model', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns OAuth credential as active when oauth tier configured', () => {
    const resolver = new AuthResolver(makeTwoTierConfig(), undefined, {
      anthropic: makeOAuthCreds(),
    });
    const active = resolver.getActiveCredential();
    expect(active?.tier).toBe('oauth');
    expect(active?.provider).toBe('anthropic');
    expect(active?.label).toBe('claude-pro');
  });

  it('falls back to keys tier when oauth tier is omitted', () => {
    const cfg = makeTwoTierConfig();
    delete cfg.oauth;
    const resolver = new AuthResolver(cfg);
    const active = resolver.getActiveCredential();
    expect(active?.tier).toBe('keys');
    expect(active?.provider).toBe('anthropic');
    expect(active?.label).toBe('main');
  });

  it('falls back to keys tier when oauth credentials are missing', () => {
    const resolver = new AuthResolver(makeTwoTierConfig());
    const active = resolver.getActiveCredential();
    expect(active?.tier).toBe('keys');
  });

  it('exhausts oauth tier before dropping to keys tier', () => {
    const resolver = new AuthResolver(makeTwoTierConfig(), undefined, {
      anthropic: makeOAuthCreds(),
    });
    resolver.markKeyFailed('anthropic', 'auth', 'invalid_grant', 0, 'oauth');
    const active = resolver.getActiveCredential();
    expect(active?.tier).toBe('keys');
    expect(active?.provider).toBe('anthropic');
    expect(active?.label).toBe('main');
  });

  it('cooldown keys for same provider in different tiers do not collide', () => {
    const resolver = new AuthResolver(makeTwoTierConfig(), undefined, {
      anthropic: makeOAuthCreds(),
    });
    resolver.markKeyFailed('anthropic', 'auth', 'oauth fail', 0, 'oauth');
    expect(resolver.isKeyInCooldown('anthropic', 0, 'oauth')).toBe(true);
    expect(resolver.isKeyInCooldown('anthropic', 0, 'keys')).toBe(false);
  });

  it('walks oauth fallback before dropping to keys tier', () => {
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'anthropic', fallback: ['openai'] },
    };
    const resolver = new AuthResolver(cfg, undefined, {
      anthropic: makeOAuthCreds(),
      openai: { ...makeOAuthCreds(), label: 'codex' },
    });
    resolver.markKeyFailed('anthropic', 'auth', 'fail', 0, 'oauth');
    const active = resolver.getActiveCredential();
    expect(active?.tier).toBe('oauth');
    expect(active?.provider).toBe('openai');
  });

  it('providerOrder includes both tiers, deduplicated', () => {
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'anthropic', fallback: [] },
    };
    const resolver = new AuthResolver(cfg, undefined, { anthropic: makeOAuthCreds() });
    expect(resolver.providerOrder).toEqual(['anthropic', 'openai']);
  });
});

describe('AuthResolver.ensureFresh', () => {
  it('refreshes OAuth credential within expiry buffer and persists', async () => {
    const persisted: OAuthCredentials[] = [];
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'anthropic', fallback: [] },
    };
    const resolver = new AuthResolver(cfg, undefined, {
      anthropic: makeOAuthCreds(60_000), // 1 min — within buffer
    });
    resolver.setPersistOAuth('anthropic', async (creds) => {
      persisted.push(creds);
    });
    const refreshed = await resolver.ensureFresh({
      refresh: async (_provider, _cred): Promise<OAuthCredentials> => ({
        access: 'new-access',
        refresh: 'rt-2',
        expires: Date.now() + 60 * 60_000,
        label: 'claude-pro',
      }),
    });
    expect(refreshed.has('anthropic')).toBe(true);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].refresh).toBe('rt-2');
  });

  it('does nothing when OAuth tier is empty', async () => {
    const cfg = makeTwoTierConfig();
    delete cfg.oauth;
    const resolver = new AuthResolver(cfg);
    const refreshed = await resolver.ensureFresh({
      refresh: async () => {
        throw new Error('should not be called');
      },
    });
    expect(refreshed.size).toBe(0);
  });

  it('does nothing when OAuth tokens are fresh', async () => {
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'anthropic', fallback: [] },
    };
    let calls = 0;
    const resolver = new AuthResolver(cfg, undefined, {
      anthropic: makeOAuthCreds(60 * 60_000), // 1 hour — fresh
    });
    await resolver.ensureFresh({
      refresh: async () => {
        calls++;
        return { access: 'x', refresh: 'y', expires: 1, label: 'l' };
      },
    });
    expect(calls).toBe(0);
  });

  it('serializes concurrent ensureFresh calls per provider', async () => {
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'anthropic', fallback: [] },
    };
    const resolver = new AuthResolver(cfg, undefined, { anthropic: makeOAuthCreds(1000) });
    let count = 0;
    const slow = async (): Promise<OAuthCredentials> => {
      count++;
      await new Promise((r) => setTimeout(r, 20));
      return {
        access: 'new',
        refresh: 'rt-2',
        expires: Date.now() + 60 * 60_000,
        label: 'claude-pro',
      };
    };
    await Promise.all([
      resolver.ensureFresh({ refresh: slow }),
      resolver.ensureFresh({ refresh: slow }),
      resolver.ensureFresh({ refresh: slow }),
    ]);
    expect(count).toBe(1);
  });

  it('throws when refresh fails', async () => {
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'anthropic', fallback: [] },
    };
    const resolver = new AuthResolver(cfg, undefined, { anthropic: makeOAuthCreds(1000) });
    await expect(
      resolver.ensureFresh({
        refresh: async () => {
          throw new Error('network down');
        },
      })
    ).rejects.toThrow('network down');
  });

  it('releases the refresh lock after failure so subsequent calls can succeed', async () => {
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'anthropic', fallback: [] },
    };
    const resolver = new AuthResolver(cfg, undefined, { anthropic: makeOAuthCreds(1000) });

    // First call: refresh fails
    await expect(
      resolver.ensureFresh({
        refresh: async () => {
          throw new Error('transient failure');
        },
      })
    ).rejects.toThrow('transient failure');

    // Second call: refresh succeeds (lock must have been released)
    const refreshed = await resolver.ensureFresh({
      refresh: async () => ({
        access: 'recovered',
        refresh: 'rt-2',
        expires: Date.now() + 60 * 60_000,
        label: 'claude-pro',
      }),
    });
    expect(refreshed.has('anthropic')).toBe(true);
    expect(resolver.getActiveCredential()?.provider).toBe('anthropic');
  });

  // Bug A regression: force-refresh bypasses the expiry check
  it('forces refresh for providers in the force list even if not near expiry', async () => {
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'anthropic', fallback: [] },
    };
    const resolver = new AuthResolver(cfg, undefined, {
      anthropic: makeOAuthCreds(60 * 60_000), // 1 hour — well within fresh window
    });
    let called = false;
    const refreshed = await resolver.ensureFresh({
      refresh: async () => {
        called = true;
        return {
          access: 'forced-new',
          refresh: 'rt-new',
          expires: Date.now() + 60 * 60_000,
          label: 'claude-pro',
        };
      },
      force: ['anthropic'],
    });
    expect(called).toBe(true);
    expect(refreshed.has('anthropic')).toBe(true);
    expect(resolver.getActiveOAuthCredential('anthropic')?.access).toBe('forced-new');
  });

  it('does not force-refresh providers not in the force list', async () => {
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'anthropic', fallback: ['openai'] },
    };
    let anthropicCalled = false;
    let openaiCalled = false;
    const resolver = new AuthResolver(cfg, undefined, {
      anthropic: makeOAuthCreds(60 * 60_000), // fresh
      openai: { ...makeOAuthCreds(60 * 60_000), label: 'openai-oauth' }, // fresh
    });
    await resolver.ensureFresh({
      refresh: async (provider, _cred) => {
        if (provider === 'anthropic') anthropicCalled = true;
        else openaiCalled = true;
        return {
          access: 'new',
          refresh: 'rt-new',
          expires: Date.now() + 60 * 60_000,
          label: provider,
        };
      },
      force: ['anthropic'], // only force anthropic
    });
    expect(anthropicCalled).toBe(true);
    expect(openaiCalled).toBe(false);
  });

  // Bug B regression: use latest credential after awaiting an existing refresh lock
  it('uses the latest credential after awaiting an existing refresh lock', async () => {
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'anthropic', fallback: [] },
    };
    const resolver = new AuthResolver(cfg, undefined, {
      anthropic: makeOAuthCreds(1000), // expiring soon
    });

    const seen: string[] = [];

    // First refresh: slow, rotates refresh token (but result still expiring soon for second refresh)
    const slow = async (
      _provider: LlmProvider,
      cred: OAuthCredentials
    ): Promise<OAuthCredentials> => {
      seen.push(cred.refresh);
      await new Promise((r) => setTimeout(r, 30));
      return {
        access: 'a1',
        refresh: 'rt-rotated',
        expires: Date.now() + 1000,
        label: cred.label,
      }; // still expiring
    };

    // Second refresh: fast, uses the rotated token from the first refresh
    const fast = async (
      _provider: LlmProvider,
      cred: OAuthCredentials
    ): Promise<OAuthCredentials> => {
      seen.push(cred.refresh);
      return {
        access: 'a2',
        refresh: 'rt-final',
        expires: Date.now() + 60 * 60_000,
        label: cred.label,
      };
    };

    // Kick off both with force so the second caller hits the post-await path
    const first = resolver.ensureFresh({ refresh: slow, force: ['anthropic'] });
    // Brief delay so `first` acquires the lock before `second` is called
    await new Promise((r) => setTimeout(r, 5));
    const second = resolver.ensureFresh({ refresh: fast, force: ['anthropic'] });
    await Promise.all([first, second]);

    // First refresh should have used the original refresh token
    expect(seen[0]).toBe('rt-xyz');
    // Second refresh should have used the rotated token written by the first refresh
    expect(seen[1]).toBe('rt-rotated');
    // Final state should reflect the second refresh
    expect(resolver.getActiveOAuthCredential('anthropic')?.refresh).toBe('rt-final');
  });

  it('passes full credential to refresh callback and persists extras', async () => {
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'google-antigravity', fallback: [] },
    };
    const expiredCred: OAuthCredentials = {
      access: 'old-access',
      refresh: 'r1',
      expires: Date.now() - 1000,
      label: 'google-antigravity',
      projectId: 'proj-1',
      email: 'a@b.com',
    };
    const resolver = new AuthResolver(cfg, undefined, {
      'google-antigravity': expiredCred,
    });

    const persisted: OAuthCredentials[] = [];
    resolver.setPersistOAuth('google-antigravity', async (c) => {
      persisted.push(c);
    });

    const refresh = vi.fn(
      async (_provider: LlmProvider, cred: OAuthCredentials): Promise<OAuthCredentials> => ({
        access: 'new-access',
        refresh: 'r2',
        expires: Date.now() + 3600_000,
        label: cred.label,
        projectId: cred.projectId, // pi-ai's antigravity refresh round-trips this
        email: cred.email,
      })
    );

    const refreshed = await resolver.ensureFresh({ refresh });
    expect(refresh).toHaveBeenCalledWith('google-antigravity', expiredCred);
    expect(refreshed.has('google-antigravity')).toBe(true);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].projectId).toBe('proj-1');
    expect(persisted[0].email).toBe('a@b.com');
    expect(persisted[0].access).toBe('new-access');
  });
});
