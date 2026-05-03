import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AuthToml, loadAuthToml } from './auth-config.js';
import {
  addKeyToApiKeyProvider,
  addProviderToApiKeysTier,
  addProviderToOAuthTier,
  readApiKeysTier,
  readOAuthTier,
  removeBraveSearch,
  removeKeyFromApiKeyProvider,
  removeProviderFromApiKeysTier,
  removeProviderFromOAuthTier,
  replaceKeyInApiKeyProvider,
  setApiKeyProviderAsPrimary,
  setApiKeysFallbackOrder,
  setBraveSearchKey,
  setOAuthFallbackOrder,
  setProviderAsPrimary,
} from './toml-patchers.js';

/**
 * Tests for `~/.system2/auth/auth.toml` patchers (0.3.0 split).
 *
 * Each patcher is a parse → mutate → write cycle, so assertions check the
 * parsed structure of auth.toml after the call rather than text patterns.
 * The previous regex-text assertions (comment preservation, header
 * placement, divider survival) no longer apply: auth.toml is machine-managed
 * and TOML.stringify always rewrites the entire file.
 */

let dir: string;
let authPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'system2-auth-patchers-'));
  authPath = join(dir, 'auth.toml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readAuth(): AuthToml {
  return loadAuthToml(authPath);
}

function seed(toml: string): void {
  writeFileSync(authPath, toml);
}

// ─── OAuth tier ───────────────────────────────────────────────────────────────

describe('readOAuthTier', () => {
  it('returns null when file is absent', () => {
    expect(readOAuthTier(authPath)).toBeNull();
  });

  it('returns null when [llm.oauth] is absent', () => {
    seed('');
    expect(readOAuthTier(authPath)).toBeNull();
  });

  it('returns null when primary is unset', () => {
    seed('[llm.oauth]\nfallback = []\n');
    expect(readOAuthTier(authPath)).toBeNull();
  });

  it('returns the tier with primary + fallback', () => {
    seed('[llm.oauth]\nprimary = "anthropic"\nfallback = ["openai-codex"]\n');
    expect(readOAuthTier(authPath)).toEqual({
      primary: 'anthropic',
      fallback: ['openai-codex'],
    });
  });
});

describe('addProviderToOAuthTier', () => {
  it('creates [llm.oauth] when absent', () => {
    const r = addProviderToOAuthTier(authPath, 'anthropic');
    expect(r.changed).toBe(true);
    expect(readAuth().llm?.oauth?.primary).toBe('anthropic');
    expect(readAuth().llm?.oauth?.fallback).toEqual([]);
  });

  it('appends to fallback when tier exists with different primary', () => {
    seed('[llm.oauth]\nprimary = "anthropic"\nfallback = []\n');
    const r = addProviderToOAuthTier(authPath, 'openai-codex');
    expect(r.changed).toBe(true);
    expect(readAuth().llm?.oauth?.fallback).toEqual(['openai-codex']);
  });

  it('no-op when provider is already primary', () => {
    seed('[llm.oauth]\nprimary = "anthropic"\nfallback = []\n');
    const r = addProviderToOAuthTier(authPath, 'anthropic');
    expect(r.changed).toBe(false);
  });

  it('no-op when provider is already in fallback', () => {
    seed('[llm.oauth]\nprimary = "anthropic"\nfallback = ["openai-codex"]\n');
    const r = addProviderToOAuthTier(authPath, 'openai-codex');
    expect(r.changed).toBe(false);
  });
});

describe('removeProviderFromOAuthTier', () => {
  it('no-op when provider not in tier', () => {
    seed('[llm.oauth]\nprimary = "anthropic"\nfallback = []\n');
    const r = removeProviderFromOAuthTier(authPath, 'openai-codex');
    expect(r.changed).toBe(false);
  });

  it('drops [llm.oauth] entirely when removing the only provider', () => {
    seed('[llm.oauth]\nprimary = "anthropic"\nfallback = []\n');
    const r = removeProviderFromOAuthTier(authPath, 'anthropic');
    expect(r.changed).toBe(true);
    expect(readAuth().llm?.oauth).toBeUndefined();
  });

  it('promotes first fallback to primary when removing the primary', () => {
    seed('[llm.oauth]\nprimary = "anthropic"\nfallback = ["openai-codex", "github-copilot"]\n');
    const r = removeProviderFromOAuthTier(authPath, 'anthropic');
    expect(r.changed).toBe(true);
    expect(readAuth().llm?.oauth?.primary).toBe('openai-codex');
    expect(readAuth().llm?.oauth?.fallback).toEqual(['github-copilot']);
  });

  it('removes from fallback array', () => {
    seed('[llm.oauth]\nprimary = "anthropic"\nfallback = ["openai-codex", "github-copilot"]\n');
    const r = removeProviderFromOAuthTier(authPath, 'openai-codex');
    expect(r.changed).toBe(true);
    expect(readAuth().llm?.oauth?.fallback).toEqual(['github-copilot']);
  });

  it('drops [llm.oauth.<provider>] sub-table along with the provider', () => {
    seed(
      '[llm.oauth]\nprimary = "anthropic"\nfallback = []\n[llm.oauth.anthropic]\nmodel = "claude-opus-4-7"\n'
    );
    removeProviderFromOAuthTier(authPath, 'anthropic');
    expect(readAuth().llm?.oauth).toBeUndefined();
  });
});

describe('setProviderAsPrimary (OAuth)', () => {
  it('throws when [llm.oauth] is unconfigured', () => {
    expect(() => setProviderAsPrimary(authPath, 'anthropic')).toThrow(/not configured/);
  });

  it('no-op when provider is already primary', () => {
    seed('[llm.oauth]\nprimary = "anthropic"\nfallback = ["openai-codex"]\n');
    const r = setProviderAsPrimary(authPath, 'anthropic');
    expect(r.changed).toBe(false);
  });

  it('swaps primary with fallback entry', () => {
    seed('[llm.oauth]\nprimary = "anthropic"\nfallback = ["openai-codex", "github-copilot"]\n');
    const r = setProviderAsPrimary(authPath, 'openai-codex');
    expect(r.changed).toBe(true);
    expect(readAuth().llm?.oauth?.primary).toBe('openai-codex');
    expect(readAuth().llm?.oauth?.fallback).toEqual(['anthropic', 'github-copilot']);
  });
});

describe('setOAuthFallbackOrder', () => {
  it('rewrites fallback verbatim', () => {
    seed('[llm.oauth]\nprimary = "anthropic"\nfallback = ["openai-codex", "github-copilot"]\n');
    setOAuthFallbackOrder(authPath, ['github-copilot', 'openai-codex']);
    expect(readAuth().llm?.oauth?.fallback).toEqual(['github-copilot', 'openai-codex']);
  });

  it('throws when [llm.oauth] is unconfigured', () => {
    expect(() => setOAuthFallbackOrder(authPath, ['openai-codex'])).toThrow(/not configured/);
  });

  it('throws when fallback contains the current primary', () => {
    // Without this guard the file would carry "anthropic" as both primary and
    // a fallback entry — the runtime would try anthropic, fail it, and try
    // anthropic again as the next fallback. Surface the misuse instead.
    seed('[llm.oauth]\nprimary = "anthropic"\nfallback = ["openai-codex"]\n');
    expect(() => setOAuthFallbackOrder(authPath, ['anthropic', 'openai-codex'])).toThrow(
      /primary cannot appear in fallback/
    );
  });
});

// ─── API keys tier ────────────────────────────────────────────────────────────

describe('readApiKeysTier', () => {
  it('returns null when file is absent', () => {
    expect(readApiKeysTier(authPath)).toBeNull();
  });

  it('returns null when primary is unset', () => {
    seed('');
    expect(readApiKeysTier(authPath)).toBeNull();
  });

  it('returns the tier with provider sub-tables listed', () => {
    seed(
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = ["openai"]\n[llm.api_keys.anthropic]\nkeys = [{ key = "k1", label = "main" }]\n[llm.api_keys.openai]\nkeys = [{ key = "k2", label = "main" }]\n`
    );
    const tier = readApiKeysTier(authPath);
    expect(tier?.primary).toBe('anthropic');
    expect(tier?.fallback).toEqual(['openai']);
    expect(tier?.providers).toEqual(new Set(['anthropic', 'openai']));
  });
});

describe('addProviderToApiKeysTier', () => {
  it('creates [llm.api_keys] when absent and writes the sub-table', () => {
    const r = addProviderToApiKeysTier(authPath, 'anthropic', [{ key: 'sk-ant', label: 'main' }]);
    expect(r.changed).toBe(true);
    const auth = readAuth();
    expect(auth.llm?.api_keys?.primary).toBe('anthropic');
    expect(auth.llm?.api_keys?.fallback).toEqual([]);
    expect((auth.llm?.api_keys?.anthropic as { keys: unknown[] })?.keys).toEqual([
      { key: 'sk-ant', label: 'main' },
    ]);
  });

  it('appends to fallback when tier exists with different primary', () => {
    seed(
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n[llm.api_keys.anthropic]\nkeys = [{ key = "k", label = "main" }]\n`
    );
    addProviderToApiKeysTier(authPath, 'openai', [{ key: 'oai', label: 'main' }]);
    const tier = readApiKeysTier(authPath);
    expect(tier?.fallback).toEqual(['openai']);
    expect(tier?.providers.has('openai')).toBe(true);
  });

  it('throws on duplicate provider when sub-table is already present', () => {
    seed(
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n[llm.api_keys.anthropic]\nkeys = [{ key = "k", label = "main" }]\n`
    );
    expect(() =>
      addProviderToApiKeysTier(authPath, 'anthropic', [{ key: 'k2', label: 'second' }])
    ).toThrow(/already in/);
  });

  it('repairs missing sub-table when provider is in tier list (hand-edit recovery)', () => {
    // Tier list mentions openai but the [llm.api_keys.openai] sub-table is gone.
    seed(
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = ["openai"]\n[llm.api_keys.anthropic]\nkeys = [{ key = "k", label = "main" }]\n`
    );
    const r = addProviderToApiKeysTier(authPath, 'openai', [{ key: 'oai', label: 'main' }]);
    expect(r.changed).toBe(true);
    const auth = readAuth();
    expect(auth.llm?.api_keys?.fallback).toEqual(['openai']); // unchanged
    expect((auth.llm?.api_keys?.openai as { keys: unknown[] })?.keys).toEqual([
      { key: 'oai', label: 'main' },
    ]);
  });

  it('throws on empty keys array', () => {
    expect(() => addProviderToApiKeysTier(authPath, 'anthropic', [])).toThrow(/empty/);
  });

  it('throws on duplicate label within keys', () => {
    expect(() =>
      addProviderToApiKeysTier(authPath, 'anthropic', [
        { key: 'k1', label: 'dup' },
        { key: 'k2', label: 'dup' },
      ])
    ).toThrow(/duplicate label/);
  });

  it('writes openai-compatible extras (base_url, model, compat_reasoning)', () => {
    addProviderToApiKeysTier(authPath, 'openai-compatible', [{ key: 'k', label: 'main' }], {
      base_url: 'http://localhost:4000/v1',
      model: 'my-model',
      compat_reasoning: true,
    });
    const sub = readAuth().llm?.api_keys?.['openai-compatible'] as {
      base_url?: string;
      model?: string;
      compat_reasoning?: boolean;
    };
    expect(sub.base_url).toBe('http://localhost:4000/v1');
    expect(sub.model).toBe('my-model');
    expect(sub.compat_reasoning).toBe(true);
  });
});

describe('removeProviderFromApiKeysTier', () => {
  it('no-op when provider not present', () => {
    seed(
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n[llm.api_keys.anthropic]\nkeys = [{ key = "k", label = "main" }]\n`
    );
    const r = removeProviderFromApiKeysTier(authPath, 'openai');
    expect(r.changed).toBe(false);
  });

  it('drops [llm.api_keys] entirely when removing the only provider', () => {
    seed(
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n[llm.api_keys.anthropic]\nkeys = [{ key = "k", label = "main" }]\n`
    );
    const r = removeProviderFromApiKeysTier(authPath, 'anthropic');
    expect(r.changed).toBe(true);
    expect(readAuth().llm?.api_keys).toBeUndefined();
  });

  it('promotes first fallback to primary when removing the primary', () => {
    seed(
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = ["openai", "google"]\n[llm.api_keys.anthropic]\nkeys = [{ key = "a", label = "m" }]\n[llm.api_keys.openai]\nkeys = [{ key = "o", label = "m" }]\n[llm.api_keys.google]\nkeys = [{ key = "g", label = "m" }]\n`
    );
    removeProviderFromApiKeysTier(authPath, 'anthropic');
    const tier = readApiKeysTier(authPath);
    expect(tier?.primary).toBe('openai');
    expect(tier?.fallback).toEqual(['google']);
    expect(tier?.providers.has('anthropic')).toBe(false);
  });
});

describe('setApiKeyProviderAsPrimary', () => {
  it('throws when [llm.api_keys] is unconfigured', () => {
    expect(() => setApiKeyProviderAsPrimary(authPath, 'anthropic')).toThrow(/not configured/);
  });

  it('throws when provider has no sub-table', () => {
    seed(
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n[llm.api_keys.anthropic]\nkeys = [{ key = "k", label = "m" }]\n`
    );
    expect(() => setApiKeyProviderAsPrimary(authPath, 'openai')).toThrow(/no \[llm\.api_keys/);
  });

  it('swaps primary with fallback entry', () => {
    seed(
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = ["openai", "google"]\n[llm.api_keys.anthropic]\nkeys = [{ key = "a", label = "m" }]\n[llm.api_keys.openai]\nkeys = [{ key = "o", label = "m" }]\n[llm.api_keys.google]\nkeys = [{ key = "g", label = "m" }]\n`
    );
    setApiKeyProviderAsPrimary(authPath, 'openai');
    const tier = readApiKeysTier(authPath);
    expect(tier?.primary).toBe('openai');
    expect(tier?.fallback).toEqual(['anthropic', 'google']);
  });
});

describe('setApiKeysFallbackOrder', () => {
  it('rewrites fallback verbatim', () => {
    seed(
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = ["openai", "google"]\n[llm.api_keys.anthropic]\nkeys = [{ key = "a", label = "m" }]\n`
    );
    setApiKeysFallbackOrder(authPath, ['google', 'openai']);
    expect(readApiKeysTier(authPath)?.fallback).toEqual(['google', 'openai']);
  });

  it('throws when fallback contains the current primary', () => {
    seed(
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = ["openai"]\n[llm.api_keys.anthropic]\nkeys = [{ key = "a", label = "m" }]\n`
    );
    expect(() => setApiKeysFallbackOrder(authPath, ['anthropic', 'openai'])).toThrow(
      /primary cannot appear in fallback/
    );
  });
});

describe('addKeyToApiKeyProvider', () => {
  beforeEach(() => {
    seed(
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n[llm.api_keys.anthropic]\nkeys = [{ key = "k1", label = "main" }]\n`
    );
  });

  it('appends a key', () => {
    addKeyToApiKeyProvider(authPath, 'anthropic', { key: 'k2', label: 'second' });
    const sub = readAuth().llm?.api_keys?.anthropic as { keys: { label: string }[] };
    expect(sub.keys.map((k) => k.label)).toEqual(['main', 'second']);
  });

  it('throws on duplicate label', () => {
    expect(() =>
      addKeyToApiKeyProvider(authPath, 'anthropic', { key: 'k2', label: 'main' })
    ).toThrow(/already exists/);
  });

  it('throws when provider is unconfigured', () => {
    expect(() => addKeyToApiKeyProvider(authPath, 'openai', { key: 'k', label: 'm' })).toThrow(
      /not configured/
    );
  });
});

describe('removeKeyFromApiKeyProvider', () => {
  it('removes a key by label', () => {
    seed(
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n[llm.api_keys.anthropic]\nkeys = [{ key = "k1", label = "main" }, { key = "k2", label = "second" }]\n`
    );
    const r = removeKeyFromApiKeyProvider(authPath, 'anthropic', 'second');
    expect(r.changed).toBe(true);
    const sub = readAuth().llm?.api_keys?.anthropic as { keys: { label: string }[] };
    expect(sub.keys.map((k) => k.label)).toEqual(['main']);
  });

  it('removes the entire provider when removing the last key', () => {
    seed(
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n[llm.api_keys.anthropic]\nkeys = [{ key = "k1", label = "main" }]\n`
    );
    removeKeyFromApiKeyProvider(authPath, 'anthropic', 'main');
    expect(readAuth().llm?.api_keys).toBeUndefined();
  });

  it('no-op when label not found', () => {
    seed(
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n[llm.api_keys.anthropic]\nkeys = [{ key = "k1", label = "main" }]\n`
    );
    const r = removeKeyFromApiKeyProvider(authPath, 'anthropic', 'missing');
    expect(r.changed).toBe(false);
  });
});

describe('replaceKeyInApiKeyProvider', () => {
  it('replaces in place without touching tier order (multi-key provider)', () => {
    seed(
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = ["openai"]\n[llm.api_keys.anthropic]\nkeys = [{ key = "k1", label = "main" }, { key = "k1b", label = "second" }]\n[llm.api_keys.openai]\nkeys = [{ key = "o", label = "m" }]\n`
    );
    replaceKeyInApiKeyProvider(authPath, 'anthropic', 'main', 'k2');
    const auth = readAuth();
    const sub = auth.llm?.api_keys?.anthropic as { keys: { key: string; label: string }[] };
    expect(sub.keys).toEqual([
      { key: 'k2', label: 'main' },
      { key: 'k1b', label: 'second' },
    ]);
    expect(auth.llm?.api_keys?.primary).toBe('anthropic');
    expect(auth.llm?.api_keys?.fallback).toEqual(['openai']);
  });

  // Regression guard: PR #162's "remove + add" dance for replace caused
  // the provider to be demoted/promoted when its sub-table briefly had zero
  // keys. The dedicated replaceKeyInApiKeyProvider must preserve tier order
  // even when the provider has only one key (no transient zero-keys state).
  it('preserves tier order when the provider has only one key (single-key regression guard)', () => {
    seed(
      `[llm.api_keys]\nprimary = "openai"\nfallback = ["anthropic"]\n[llm.api_keys.openai]\nkeys = [{ key = "o", label = "m" }]\n[llm.api_keys.anthropic]\nkeys = [{ key = "k1", label = "only" }]\n`
    );
    replaceKeyInApiKeyProvider(authPath, 'anthropic', 'only', 'k2');
    const auth = readAuth();
    expect(auth.llm?.api_keys?.primary).toBe('openai');
    expect(auth.llm?.api_keys?.fallback).toEqual(['anthropic']);
    const sub = auth.llm?.api_keys?.anthropic as { keys: { key: string; label: string }[] };
    expect(sub.keys).toEqual([{ key: 'k2', label: 'only' }]);
  });

  it('throws when label not found', () => {
    seed(
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n[llm.api_keys.anthropic]\nkeys = [{ key = "k1", label = "main" }]\n`
    );
    expect(() => replaceKeyInApiKeyProvider(authPath, 'anthropic', 'nope', 'k2')).toThrow(
      /no key labeled/
    );
  });
});

// ─── Brave Search + web_search ────────────────────────────────────────────────

describe('setBraveSearchKey', () => {
  it('writes [services.brave_search] AND enables [tools.web_search]', () => {
    setBraveSearchKey(authPath, 'BSA-key');
    const auth = readAuth();
    expect(auth.services?.brave_search?.key).toBe('BSA-key');
    expect(auth.tools?.web_search?.enabled).toBe(true);
  });

  it('updates the key when called again with a different value', () => {
    setBraveSearchKey(authPath, 'BSA-old');
    const r = setBraveSearchKey(authPath, 'BSA-new');
    expect(r.changed).toBe(true);
    expect(readAuth().services?.brave_search?.key).toBe('BSA-new');
  });

  it('reports unchanged when the same key is written twice', () => {
    setBraveSearchKey(authPath, 'BSA-same');
    const r = setBraveSearchKey(authPath, 'BSA-same');
    expect(r.changed).toBe(false);
  });

  it('throws on empty key', () => {
    expect(() => setBraveSearchKey(authPath, '')).toThrow(/empty/);
  });
});

describe('removeBraveSearch', () => {
  it('removes both [services.brave_search] and [tools.web_search]', () => {
    setBraveSearchKey(authPath, 'BSA-key');
    const r = removeBraveSearch(authPath);
    expect(r.changed).toBe(true);
    const auth = readAuth();
    expect(auth.services?.brave_search).toBeUndefined();
    expect(auth.tools?.web_search).toBeUndefined();
  });

  it('no-op when neither section exists', () => {
    seed('');
    const r = removeBraveSearch(authPath);
    expect(r.changed).toBe(false);
  });
});

// ─── Cross-cutting: file format invariants ────────────────────────────────────

describe('file format invariants', () => {
  it('every write includes the do-not-edit header', () => {
    addProviderToOAuthTier(authPath, 'anthropic');
    const text = readFileSync(authPath, 'utf-8');
    expect(text).toMatch(/^# Managed by 'system2 config'/);
  });

  it('writes parseable TOML', () => {
    addProviderToOAuthTier(authPath, 'anthropic');
    addProviderToApiKeysTier(authPath, 'openai', [{ key: 'k', label: 'm' }]);
    setBraveSearchKey(authPath, 'BSA-key');
    expect(() => TOML.parse(readFileSync(authPath, 'utf-8'))).not.toThrow();
  });

  it('does not leave empty tables behind after a remove', () => {
    addProviderToOAuthTier(authPath, 'anthropic');
    removeProviderFromOAuthTier(authPath, 'anthropic');
    const text = readFileSync(authPath, 'utf-8');
    expect(text).not.toMatch(/\[llm\]/);
    expect(text).not.toMatch(/\[llm\.oauth\]/);
  });

  it('creates the file on first write when absent', () => {
    expect(existsSync(authPath)).toBe(false);
    addProviderToOAuthTier(authPath, 'anthropic');
    expect(existsSync(authPath)).toBe(true);
  });
});
