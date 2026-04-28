import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addProviderToOAuthTier } from './login.js';

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

  it('adds [llm.oauth] section when missing', () => {
    writeFileSync(
      configPath,
      `[llm]\nprimary = "anthropic"\nfallback = []\n\n[llm.anthropic]\nkeys = []\n`
    );
    const result = addProviderToOAuthTier(configPath, 'anthropic');
    expect(result.changed).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toMatch(/\[llm\.oauth\][\s\S]*primary\s*=\s*"anthropic"/);
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
});
