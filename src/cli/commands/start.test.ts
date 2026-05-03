import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmConfig } from '../../shared/index.js';
import { formatTierBanner, hasConfiguredCredentialTier, probeCredentialTier } from './start.js';

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

describe('probeCredentialTier (four-state)', () => {
  let dir: string;
  let configPath: string;
  let authPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-start-test-'));
    configPath = join(dir, 'config.toml');
    mkdirSync(join(dir, 'auth'), { mode: 0o700 });
    authPath = join(dir, 'auth', 'auth.toml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns not_initialized when config.toml is missing', () => {
    expect(probeCredentialTier(configPath, authPath).kind).toBe('not_initialized');
  });

  it('returns missing when config.toml exists but auth.toml does not', () => {
    writeFileSync(configPath, '');
    expect(probeCredentialTier(configPath, authPath).kind).toBe('missing');
  });

  it('returns missing when auth.toml has no primary in either tier', () => {
    writeFileSync(configPath, '');
    writeFileSync(authPath, '');
    expect(probeCredentialTier(configPath, authPath).kind).toBe('missing');
  });

  it('returns malformed (config) when config.toml is invalid TOML', () => {
    writeFileSync(configPath, 'not valid toml = = =');
    writeFileSync(authPath, '');
    const status = probeCredentialTier(configPath, authPath);
    expect(status.kind).toBe('malformed');
    if (status.kind === 'malformed') expect(status.file).toBe('config');
  });

  it('returns malformed (auth) when auth.toml is invalid TOML', () => {
    writeFileSync(configPath, '');
    writeFileSync(authPath, 'not valid = = =');
    const status = probeCredentialTier(configPath, authPath);
    expect(status.kind).toBe('malformed');
    if (status.kind === 'malformed') expect(status.file).toBe('auth');
  });

  it('returns configured when [llm.oauth].primary is set in auth.toml', () => {
    writeFileSync(configPath, '');
    writeFileSync(authPath, `[llm.oauth]\nprimary = "anthropic"\nfallback = []\n`);
    expect(probeCredentialTier(configPath, authPath).kind).toBe('configured');
  });

  it('returns configured when [llm.api_keys].primary is set in auth.toml', () => {
    writeFileSync(configPath, '');
    writeFileSync(
      authPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n[llm.api_keys.anthropic]\nkeys = [{ key = "x", label = "y" }]\n`
    );
    expect(probeCredentialTier(configPath, authPath).kind).toBe('configured');
  });
});

describe('hasConfiguredCredentialTier (boolean shim)', () => {
  let dir: string;
  let configPath: string;
  let authPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-start-test-'));
    configPath = join(dir, 'config.toml');
    mkdirSync(join(dir, 'auth'), { mode: 0o700 });
    authPath = join(dir, 'auth', 'auth.toml');
    writeFileSync(configPath, '');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when auth.toml is absent', () => {
    expect(hasConfiguredCredentialTier(configPath, authPath)).toBe(false);
  });

  it('returns true when [llm.oauth].primary is set', () => {
    writeFileSync(authPath, `[llm.oauth]\nprimary = "anthropic"\nfallback = []\n`);
    expect(hasConfiguredCredentialTier(configPath, authPath)).toBe(true);
  });

  it('returns true when [llm.api_keys].primary is set', () => {
    writeFileSync(
      authPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n[llm.api_keys.anthropic]\nkeys = [{ key = "x", label = "y" }]\n`
    );
    expect(hasConfiguredCredentialTier(configPath, authPath)).toBe(true);
  });
});
