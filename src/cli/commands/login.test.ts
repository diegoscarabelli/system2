import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addProviderToOAuthTier, removeProviderFromOAuthTier } from './login.js';

describe('addProviderToOAuthTier', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-login-test-'));
    configPath = join(dir, 'config.toml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds [llm.oauth] section when missing, between [llm] and [llm.anthropic]', () => {
    writeFileSync(
      configPath,
      `[llm]\nprimary = "anthropic"\nfallback = []\n\n[llm.anthropic]\nkeys = []\n`
    );
    const result = addProviderToOAuthTier(configPath, 'anthropic');
    expect(result.changed).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toMatch(/\[llm\.oauth\][\s\S]*primary\s*=\s*"anthropic"/);
    // Position check: [llm.oauth] must come before [llm.anthropic]
    const oauthIdx = content.indexOf('[llm.oauth]');
    const anthropicIdx = content.indexOf('[llm.anthropic]');
    expect(oauthIdx).toBeGreaterThan(-1);
    expect(anthropicIdx).toBeGreaterThan(oauthIdx);
  });

  it('appends to fallback when oauth section exists with different primary', () => {
    writeFileSync(
      configPath,
      `[llm]\nprimary = "anthropic"\nfallback = []\n\n[llm.oauth]\nprimary = "google"\nfallback = []\n\n[llm.anthropic]\nkeys = []\n`
    );
    const result = addProviderToOAuthTier(configPath, 'anthropic');
    expect(result.changed).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toMatch(/primary\s*=\s*"google"/);
    expect(content).toMatch(/fallback\s*=\s*\[\s*"anthropic"\s*\]/);
  });

  it('is a no-op when provider already in oauth tier', () => {
    writeFileSync(
      configPath,
      `[llm]\nprimary = "anthropic"\nfallback = []\n\n[llm.oauth]\nprimary = "anthropic"\nfallback = []\n\n[llm.anthropic]\nkeys = []\n`
    );
    const before = readFileSync(configPath, 'utf-8');
    const result = addProviderToOAuthTier(configPath, 'anthropic');
    expect(result.changed).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('inserts fallback line when [llm.oauth] has primary but no fallback', () => {
    writeFileSync(
      configPath,
      `[llm]\nprimary = "anthropic"\nfallback = []\n\n[llm.oauth]\nprimary = "google"\n\n[llm.anthropic]\nkeys = []\n`
    );
    const result = addProviderToOAuthTier(configPath, 'anthropic');
    expect(result.changed).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toMatch(/primary\s*=\s*"google"/);
    expect(content).toMatch(/fallback\s*=\s*\[\s*"anthropic"\s*\]/);
  });
});

describe('removeProviderFromOAuthTier', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-login-remove-test-'));
    configPath = join(dir, 'config.toml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes provider when it is the only entry: drops [llm.oauth] section', () => {
    writeFileSync(
      configPath,
      `[llm]\nprimary = "anthropic"\nfallback = []\n\n[llm.oauth]\nprimary = "anthropic"\nfallback = []\n\n[llm.anthropic]\nkeys = []\n`
    );
    const result = removeProviderFromOAuthTier(configPath, 'anthropic');
    expect(result.changed).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).not.toMatch(/\[llm\.oauth\]/);
  });

  it('removes provider from fallback', () => {
    writeFileSync(
      configPath,
      `[llm]\nprimary = "anthropic"\nfallback = []\n\n[llm.oauth]\nprimary = "google"\nfallback = ["anthropic"]\n\n[llm.anthropic]\nkeys = []\n`
    );
    const result = removeProviderFromOAuthTier(configPath, 'anthropic');
    expect(result.changed).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toMatch(/primary\s*=\s*"google"/);
    expect(content).toMatch(/fallback\s*=\s*\[\]/);
  });

  it('promotes first fallback when removing primary', () => {
    writeFileSync(
      configPath,
      `[llm]\nprimary = "anthropic"\nfallback = []\n\n[llm.oauth]\nprimary = "anthropic"\nfallback = ["google"]\n\n[llm.anthropic]\nkeys = []\n`
    );
    const result = removeProviderFromOAuthTier(configPath, 'anthropic');
    expect(result.changed).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toMatch(/primary\s*=\s*"google"/);
    expect(content).toMatch(/fallback\s*=\s*\[\]/);
  });

  it('is a no-op when provider not in oauth tier', () => {
    writeFileSync(
      configPath,
      `[llm]\nprimary = "anthropic"\nfallback = []\n\n[llm.oauth]\nprimary = "google"\nfallback = []\n\n[llm.anthropic]\nkeys = []\n`
    );
    const before = readFileSync(configPath, 'utf-8');
    const result = removeProviderFromOAuthTier(configPath, 'anthropic');
    expect(result.changed).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });
});
