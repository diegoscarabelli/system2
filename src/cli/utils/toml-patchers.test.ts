import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setOAuthFallbackOrder } from './toml-patchers.js';

describe('setOAuthFallbackOrder', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-toml-test-'));
    configPath = join(dir, 'config.toml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('overwrites the fallback array in declaration order', () => {
    writeFileSync(
      configPath,
      `[llm.oauth]\nprimary = "anthropic"\nfallback = ["openai-codex", "github-copilot"]\n`
    );
    const result = setOAuthFallbackOrder(configPath, ['github-copilot', 'openai-codex']);
    expect(result.changed).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toMatch(
      /fallback\s*=\s*\[\s*"github-copilot"\s*,\s*"openai-codex"\s*\]/
    );
  });

  it('throws when an entry is the current primary', () => {
    writeFileSync(
      configPath,
      `[llm.oauth]\nprimary = "anthropic"\nfallback = ["openai-codex"]\n`
    );
    expect(() => setOAuthFallbackOrder(configPath, ['anthropic'])).toThrow(
      /primary cannot appear in fallback/
    );
  });

  it('is a no-op when supplied order matches current order', () => {
    writeFileSync(
      configPath,
      `[llm.oauth]\nprimary = "anthropic"\nfallback = ["openai-codex", "github-copilot"]\n`
    );
    const before = readFileSync(configPath, 'utf-8');
    const result = setOAuthFallbackOrder(configPath, ['openai-codex', 'github-copilot']);
    expect(result.changed).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('throws when [llm.oauth] section is absent', () => {
    writeFileSync(configPath, `[llm]\nprimary = "anthropic"\n`);
    expect(() => setOAuthFallbackOrder(configPath, [])).toThrow(/\[llm\.oauth\] section not found/);
  });
});
