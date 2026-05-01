import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmConfig } from '../../shared/index.js';
import { AuthResolver } from './auth-resolver.js';
import { loadOAuthCredentials, saveOAuthCredentials } from './oauth-credentials.js';

function makeTwoTierConfig(): LlmConfig {
  return {
    primary: 'anthropic',
    fallback: ['openai'],
    providers: {
      anthropic: { keys: [{ key: 'sk-ant-api03-fallback', label: 'api-fallback' }] },
      openai: { keys: [{ key: 'oai-1', label: 'main' }] },
    },
    oauth: { primary: 'anthropic', fallback: [], providers: {} },
  };
}

describe('OAuth end-to-end flow', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'system2-oauth-e2e-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('loads, refreshes, persists, and prefers OAuth tier over keys tier', async () => {
    saveOAuthCredentials(tmpDir, 'anthropic', {
      access: 'sk-ant-oat-old',
      refresh: 'rt-1',
      expires: Date.now() + 60_000,
      label: 'claude-pro',
    });

    const loaded = loadOAuthCredentials(tmpDir, 'anthropic');
    if (!loaded) throw new Error('expected credentials to load');

    const resolver = new AuthResolver(makeTwoTierConfig(), undefined, {
      anthropic: loaded,
    });

    resolver.setPersistOAuth('anthropic', async (creds) => {
      saveOAuthCredentials(tmpDir, 'anthropic', creds);
    });

    let active = resolver.getActiveCredential();
    expect(active?.tier).toBe('oauth');
    expect(active?.label).toBe('claude-pro');

    const fakeRefresh = vi.fn(async () => ({
      access: 'sk-ant-oat-new',
      refresh: 'rt-2',
      expires: Date.now() + 60 * 60_000,
      label: 'claude-pro',
    }));
    const refreshed = await resolver.ensureFresh({ refresh: fakeRefresh });
    expect(refreshed.has('anthropic')).toBe(true);
    expect(fakeRefresh).toHaveBeenCalledOnce();

    const reloaded = loadOAuthCredentials(tmpDir, 'anthropic');
    expect(reloaded?.access).toBe('sk-ant-oat-new');
    expect(reloaded?.refresh).toBe('rt-2');

    active = resolver.getActiveCredential();
    expect(active?.tier).toBe('oauth');
  });

  it('drops to keys tier only after OAuth tier is exhausted', async () => {
    saveOAuthCredentials(tmpDir, 'anthropic', {
      access: 'sk-ant-oat-old',
      refresh: 'rt-1',
      expires: Date.now() + 60 * 60_000,
      label: 'claude-pro',
    });
    const loaded = loadOAuthCredentials(tmpDir, 'anthropic');
    if (!loaded) throw new Error('expected credentials to load');
    const resolver = new AuthResolver(makeTwoTierConfig(), undefined, {
      anthropic: loaded,
    });

    expect(resolver.getActiveCredential()?.tier).toBe('oauth');

    resolver.markKeyFailed('anthropic', 'auth', 'invalid_grant', 0, 'oauth');

    const active = resolver.getActiveCredential();
    expect(active?.tier).toBe('api_keys');
    expect(active?.provider).toBe('anthropic');
    expect(active?.label).toBe('api-fallback');
  });

  it('cycles through entire OAuth tier before dropping to keys tier', async () => {
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'anthropic', fallback: ['openai'], providers: {} },
    };
    saveOAuthCredentials(tmpDir, 'anthropic', {
      access: 'a',
      refresh: 'ar',
      expires: Date.now() + 60 * 60_000,
      label: 'claude-pro',
    });
    saveOAuthCredentials(tmpDir, 'openai', {
      access: 'o',
      refresh: 'or',
      expires: Date.now() + 60 * 60_000,
      label: 'codex',
    });
    const a = loadOAuthCredentials(tmpDir, 'anthropic');
    const o = loadOAuthCredentials(tmpDir, 'openai');
    if (!a || !o) throw new Error('expected credentials to load');
    const resolver = new AuthResolver(cfg, undefined, {
      anthropic: a,
      openai: o,
    });

    expect(resolver.getActiveCredential()).toMatchObject({
      tier: 'oauth',
      provider: 'anthropic',
    });

    resolver.markKeyFailed('anthropic', 'auth', 'fail', 0, 'oauth');
    expect(resolver.getActiveCredential()).toMatchObject({ tier: 'oauth', provider: 'openai' });

    resolver.markKeyFailed('openai', 'auth', 'fail', 0, 'oauth');
    expect(resolver.getActiveCredential()).toMatchObject({
      tier: 'api_keys',
      provider: 'anthropic',
    });
  });
});
