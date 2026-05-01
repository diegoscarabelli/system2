/**
 * Tests for the OAuth-tier model resolver.
 *
 * Covers the natural-sort comparator + family-prefix resolver. pi-ai is mocked
 * with a synthetic catalog so the tests don't depend on a particular catalog
 * snapshot in node_modules.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@mariozechner/pi-ai', () => ({
  getProviders: () => ['anthropic', 'openai-codex', 'github-copilot'],
  getModels: (provider: string) => {
    const catalogs: Record<string, Array<{ id: string; contextWindow: number }>> = {
      anthropic: [
        { id: 'claude-haiku-4-5-20251001', contextWindow: 200000 },
        { id: 'claude-sonnet-4-6', contextWindow: 200000 },
        { id: 'claude-opus-4-6', contextWindow: 200000 },
        { id: 'claude-opus-4-7', contextWindow: 200000 },
        // alias + date-snapshot pair, to exercise the snapshot filter
        { id: 'claude-opus-4-5', contextWindow: 200000 },
        { id: 'claude-opus-4-5-20251101', contextWindow: 200000 },
      ],
      'openai-codex': [
        { id: 'gpt-5.4-mini', contextWindow: 128000 },
        { id: 'gpt-5.4', contextWindow: 272000 },
        { id: 'gpt-5.3-codex', contextWindow: 272000 },
        { id: 'gpt-5.5', contextWindow: 272000 },
      ],
      'github-copilot': [
        { id: 'gpt-4.1', contextWindow: 128000 },
        { id: 'gpt-4o', contextWindow: 128000 },
        { id: 'gpt-5', contextWindow: 200000 },
        { id: 'gpt-5.4', contextWindow: 272000 },
        { id: 'gpt-5-mini', contextWindow: 128000 },
        { id: 'claude-opus-4.6', contextWindow: 200000 },
      ],
    };
    return catalogs[provider] ?? [];
  },
}));

describe('compareNatural', () => {
  it('compares numeric segments numerically (5.10 > 5.4)', async () => {
    const { compareNatural } = await import('./oauth-models.js');
    expect(compareNatural('gpt-5.10', 'gpt-5.4')).toBeGreaterThan(0);
  });

  it('lex-compares pure string segments at the same position', async () => {
    const { compareNatural } = await import('./oauth-models.js');
    // Position 3: 'codex' vs end-of-array → longer wins; codex > nothing.
    expect(compareNatural('gpt-5.4-codex', 'gpt-5.4')).toBeGreaterThan(0);
  });

  it('treats numeric > string when types differ at the same position', async () => {
    const { compareNatural } = await import('./oauth-models.js');
    // gemini-3.1-pro → [gemini, 3, 1, pro];   gemini-3-pro → [gemini, 3, pro]
    // Position 2: 1 (number) vs 'pro' (string) → numeric wins.
    expect(compareNatural('gemini-3.1-pro', 'gemini-3-pro')).toBeGreaterThan(0);
  });

  it('returns 0 for identical ids', async () => {
    const { compareNatural } = await import('./oauth-models.js');
    expect(compareNatural('claude-opus-4-6', 'claude-opus-4-6')).toBe(0);
  });
});

describe('resolveOAuthModel', () => {
  it('picks the latest opus alias for anthropic (snapshot filtered)', async () => {
    const { resolveOAuthModel } = await import('./oauth-models.js');
    // Aliases present: claude-opus-4-5, claude-opus-4-6, claude-opus-4-7.
    // Snapshot claude-opus-4-5-20251101 is filtered out.
    expect(resolveOAuthModel('anthropic')).toBe('claude-opus-4-7');
  });

  it('picks gpt-5.5 for openai-codex (excludes -mini)', async () => {
    const { resolveOAuthModel } = await import('./oauth-models.js');
    expect(resolveOAuthModel('openai-codex')).toBe('gpt-5.5');
  });

  it('picks the latest plain gpt-5.x for github-copilot (excludes mini, claude)', async () => {
    const { resolveOAuthModel } = await import('./oauth-models.js');
    expect(resolveOAuthModel('github-copilot')).toBe('gpt-5.4');
  });

  it('returns undefined for a provider with no family or fallback entry', async () => {
    const { resolveOAuthModel } = await import('./oauth-models.js');
    // groq has no entry in OAUTH_FAMILIES nor OAUTH_FALLBACKS.
    expect(resolveOAuthModel('groq')).toBeUndefined();
  });

  it('returns the fallback when family pattern matches nothing in catalog', async () => {
    // Re-mock to return a catalog with no opus entries.
    vi.doMock('@mariozechner/pi-ai', () => ({
      getProviders: () => ['anthropic'],
      getModels: () => [{ id: 'claude-sonnet-4-6', contextWindow: 200000 }],
    }));
    vi.resetModules();
    const { resolveOAuthModel, OAUTH_FALLBACKS } = await import('./oauth-models.js');
    expect(resolveOAuthModel('anthropic')).toBe(OAUTH_FALLBACKS.anthropic);
    vi.doUnmock('@mariozechner/pi-ai');
  });
});
