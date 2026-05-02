import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmConfig } from '../../shared/index.js';
import { formatTierBanner, hasConfiguredCredentialTier } from './start.js';

describe('formatTierBanner', () => {
  it('shows only OAuth line when api-keys has no provider keys', () => {
    // Mirrors the synthesized shape onboard writes when the user skips
    // api-keys: primary is set (defaulted to oauth primary) but no
    // provider in `providers` has any keys. The banner must NOT
    // advertise an api-keys tier in this state.
    const llm: LlmConfig = {
      primary: 'github-copilot',
      fallback: [],
      providers: { 'github-copilot': { keys: [] } },
      oauth: { primary: 'github-copilot', fallback: ['anthropic'], providers: {} },
    };
    expect(formatTierBanner(llm)).toEqual(['  OAuth tier:   github-copilot → anthropic']);
  });

  it('shows only api-keys line when no oauth tier is set', () => {
    const llm: LlmConfig = {
      primary: 'anthropic',
      fallback: ['openai'],
      providers: {
        anthropic: { keys: [{ key: 'sk-ant', label: 'main' }] },
        openai: { keys: [{ key: 'sk-oai', label: 'main' }] },
      },
    };
    expect(formatTierBanner(llm)).toEqual(['  API key tier: anthropic → openai']);
  });

  it('shows both lines with full failover chains when both tiers are configured', () => {
    const llm: LlmConfig = {
      primary: 'anthropic',
      fallback: ['google'],
      providers: {
        anthropic: { keys: [{ key: 'sk-ant', label: 'main' }] },
        google: { keys: [{ key: 'gk', label: 'main' }] },
      },
      oauth: {
        primary: 'github-copilot',
        fallback: ['anthropic', 'openai-codex'],
        providers: {},
      },
    };
    expect(formatTierBanner(llm)).toEqual([
      '  OAuth tier:   github-copilot → anthropic → openai-codex',
      '  API key tier: anthropic → google',
    ]);
  });

  it('returns empty array when neither tier has credentials', () => {
    // Config edited so all api-keys are empty and no oauth — start.ts
    // uses an empty result to print a friendly error and exit.
    const llm: LlmConfig = {
      primary: 'anthropic',
      fallback: [],
      providers: { anthropic: { keys: [] } },
    };
    expect(formatTierBanner(llm)).toEqual([]);
  });

  it('omits arrow when fallback is empty (single-provider chain)', () => {
    const llm: LlmConfig = {
      primary: 'anthropic',
      fallback: [],
      providers: {},
      oauth: { primary: 'anthropic', fallback: [], providers: {} },
    };
    expect(formatTierBanner(llm)).toEqual(['  OAuth tier:   anthropic']);
  });
});

describe('hasConfiguredCredentialTier', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-start-test-'));
    configPath = join(dir, 'config.toml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns false for empty (commented-template) config', () => {
    writeFileSync(configPath, `# [llm.oauth]\n# primary = "anthropic"\n`);
    expect(hasConfiguredCredentialTier(configPath)).toBe(false);
  });

  it('returns true when [llm.oauth].primary is set', () => {
    writeFileSync(configPath, `[llm.oauth]\nprimary = "anthropic"\nfallback = []\n`);
    expect(hasConfiguredCredentialTier(configPath)).toBe(true);
  });

  it('returns true when [llm.api_keys].primary is set', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n[llm.api_keys.anthropic]\nkeys = [{ key = "x", label = "y" }]\n`
    );
    expect(hasConfiguredCredentialTier(configPath)).toBe(true);
  });
});
