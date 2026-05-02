import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addKeyToApiKeyProvider,
  addProviderToApiKeysTier,
  removeBraveSearch,
  removeKeyFromApiKeyProvider,
  removeProviderFromApiKeysTier,
  setApiKeyProviderAsPrimary,
  setApiKeysFallbackOrder,
  setBraveSearchKey,
  setOAuthFallbackOrder,
} from './toml-patchers.js';

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
    expect(content).toMatch(/fallback\s*=\s*\[\s*"github-copilot"\s*,\s*"openai-codex"\s*\]/);
  });

  it('throws when an entry is the current primary', () => {
    writeFileSync(configPath, `[llm.oauth]\nprimary = "anthropic"\nfallback = ["openai-codex"]\n`);
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

describe('addProviderToApiKeysTier', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-toml-test-'));
    configPath = join(dir, 'config.toml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates [llm.api_keys] section when missing, with provider as primary', () => {
    writeFileSync(configPath, `[llm]\n`);
    const result = addProviderToApiKeysTier(configPath, 'anthropic', [
      { key: 'sk-ant-1', label: 'personal' },
    ]);
    expect(result.changed).toBe(true);
    const parsed = TOML.parse(readFileSync(configPath, 'utf-8')) as {
      llm?: {
        api_keys?: {
          primary?: string;
          fallback?: string[];
          anthropic?: { keys?: Array<{ key: string; label: string }> };
        };
      };
    };
    expect(parsed.llm?.api_keys?.primary).toBe('anthropic');
    expect(parsed.llm?.api_keys?.fallback).toEqual([]);
    expect(parsed.llm?.api_keys?.anthropic?.keys).toEqual([{ key: 'sk-ant-1', label: 'personal' }]);
  });

  it('appends to fallback when api_keys section exists with different primary', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "openai"\nfallback = []\n\n[llm.api_keys.openai]\nkeys = [\n  { key = "sk-1", label = "default" },\n]\n`
    );
    const result = addProviderToApiKeysTier(configPath, 'anthropic', [
      { key: 'sk-ant-1', label: 'default' },
    ]);
    expect(result.changed).toBe(true);
    const parsed = TOML.parse(readFileSync(configPath, 'utf-8')) as {
      llm?: { api_keys?: { primary?: string; fallback?: string[] } };
    };
    expect(parsed.llm?.api_keys?.primary).toBe('openai');
    expect(parsed.llm?.api_keys?.fallback).toEqual(['anthropic']);
  });

  it('throws when provider is already in tier', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n\n[llm.api_keys.anthropic]\nkeys = [\n  { key = "sk-1", label = "default" },\n]\n`
    );
    expect(() =>
      addProviderToApiKeysTier(configPath, 'anthropic', [{ key: 'sk-2', label: 'work' }])
    ).toThrow(/already in \[llm\.api_keys\]/);
  });
});

describe('removeProviderFromApiKeysTier', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-toml-test-'));
    configPath = join(dir, 'config.toml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('promotes head of fallback to primary when removing the primary', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = ["openai", "google"]\n\n[llm.api_keys.anthropic]\nkeys = [\n  { key = "sk-a", label = "default" },\n]\n\n[llm.api_keys.openai]\nkeys = [\n  { key = "sk-o", label = "default" },\n]\n\n[llm.api_keys.google]\nkeys = [\n  { key = "g-1", label = "default" },\n]\n`
    );
    const result = removeProviderFromApiKeysTier(configPath, 'anthropic');
    expect(result.changed).toBe(true);
    const parsed = TOML.parse(readFileSync(configPath, 'utf-8')) as {
      llm?: { api_keys?: Record<string, unknown> & { primary?: string; fallback?: string[] } };
    };
    expect(parsed.llm?.api_keys?.primary).toBe('openai');
    expect(parsed.llm?.api_keys?.fallback).toEqual(['google']);
    expect(parsed.llm?.api_keys?.anthropic).toBeUndefined();
  });

  it('drops [llm.api_keys] entirely when removing the only provider', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n\n[llm.api_keys.anthropic]\nkeys = [\n  { key = "sk-a", label = "default" },\n]\n`
    );
    const result = removeProviderFromApiKeysTier(configPath, 'anthropic');
    expect(result.changed).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).not.toMatch(/\[llm\.api_keys\]/);
    expect(content).not.toMatch(/\[llm\.api_keys\.anthropic\]/);
  });

  it('removes from fallback list without touching primary', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = ["openai", "google"]\n\n[llm.api_keys.anthropic]\nkeys = [\n  { key = "sk-a", label = "default" },\n]\n\n[llm.api_keys.openai]\nkeys = [\n  { key = "sk-o", label = "default" },\n]\n\n[llm.api_keys.google]\nkeys = [\n  { key = "g-1", label = "default" },\n]\n`
    );
    const result = removeProviderFromApiKeysTier(configPath, 'openai');
    expect(result.changed).toBe(true);
    const parsed = TOML.parse(readFileSync(configPath, 'utf-8')) as {
      llm?: { api_keys?: Record<string, unknown> & { primary?: string; fallback?: string[] } };
    };
    expect(parsed.llm?.api_keys?.primary).toBe('anthropic');
    expect(parsed.llm?.api_keys?.fallback).toEqual(['google']);
    expect(parsed.llm?.api_keys?.openai).toBeUndefined();
  });

  it('is a no-op when provider not in tier', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n\n[llm.api_keys.anthropic]\nkeys = [\n  { key = "sk-a", label = "default" },\n]\n`
    );
    const before = readFileSync(configPath, 'utf-8');
    const result = removeProviderFromApiKeysTier(configPath, 'openai');
    expect(result.changed).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('also removes [llm.api_keys.<provider>.<sub>] children (e.g. .models)', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = ["openai"]\n\n[llm.api_keys.anthropic]\nkeys = [\n  { key = "sk-a", label = "default" },\n]\n\n[llm.api_keys.anthropic.models]\nnarrator = "claude-haiku-4-5-20251001"\n\n[llm.api_keys.openai]\nkeys = [\n  { key = "sk-o", label = "default" },\n]\n`
    );
    const result = removeProviderFromApiKeysTier(configPath, 'anthropic');
    expect(result.changed).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).not.toMatch(/\[llm\.api_keys\.anthropic\.models\]/);
    expect(content).not.toMatch(/\[llm\.api_keys\.anthropic\]/);
    expect(content).toMatch(/\[llm\.api_keys\.openai\]/);
  });
});

describe('setApiKeyProviderAsPrimary', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-toml-test-'));
    configPath = join(dir, 'config.toml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('promotes a fallback to primary; demotes old primary to head of fallback', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = ["openai", "google"]\n\n[llm.api_keys.anthropic]\nkeys = [\n  { key = "sk-a", label = "default" },\n]\n`
    );
    const result = setApiKeyProviderAsPrimary(configPath, 'openai');
    expect(result.changed).toBe(true);
    const parsed = TOML.parse(readFileSync(configPath, 'utf-8')) as {
      llm?: { api_keys?: { primary?: string; fallback?: string[] } };
    };
    expect(parsed.llm?.api_keys?.primary).toBe('openai');
    expect(parsed.llm?.api_keys?.fallback).toEqual(['anthropic', 'google']);
  });

  it('is a no-op when provider is already primary', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n\n[llm.api_keys.anthropic]\nkeys = [\n  { key = "sk-a", label = "default" },\n]\n`
    );
    const before = readFileSync(configPath, 'utf-8');
    const result = setApiKeyProviderAsPrimary(configPath, 'anthropic');
    expect(result.changed).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('throws when [llm.api_keys] is absent', () => {
    writeFileSync(configPath, `[llm]\n`);
    expect(() => setApiKeyProviderAsPrimary(configPath, 'anthropic')).toThrow(
      /\[llm\.api_keys\] section not found/
    );
  });
});

describe('setApiKeysFallbackOrder', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-toml-test-'));
    configPath = join(dir, 'config.toml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('overwrites fallback in the supplied order', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = ["openai", "google"]\n`
    );
    const result = setApiKeysFallbackOrder(configPath, ['google', 'openai']);
    expect(result.changed).toBe(true);
    const parsed = TOML.parse(readFileSync(configPath, 'utf-8')) as {
      llm?: { api_keys?: { fallback?: string[] } };
    };
    expect(parsed.llm?.api_keys?.fallback).toEqual(['google', 'openai']);
  });

  it('throws when an entry is the current primary', () => {
    writeFileSync(configPath, `[llm.api_keys]\nprimary = "anthropic"\nfallback = ["openai"]\n`);
    expect(() => setApiKeysFallbackOrder(configPath, ['anthropic'])).toThrow(
      /primary cannot appear in fallback/
    );
  });
});

describe('addKeyToApiKeyProvider', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-toml-test-'));
    configPath = join(dir, 'config.toml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends a new key to the keys array', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n\n[llm.api_keys.anthropic]\nkeys = [\n  { key = "sk-a-1", label = "personal" },\n]\n`
    );
    const result = addKeyToApiKeyProvider(configPath, 'anthropic', {
      key: 'sk-a-2',
      label: 'work',
    });
    expect(result.changed).toBe(true);
    const parsed = TOML.parse(readFileSync(configPath, 'utf-8')) as {
      llm?: { api_keys?: { anthropic?: { keys?: Array<{ key: string; label: string }> } } };
    };
    expect(parsed.llm?.api_keys?.anthropic?.keys).toEqual([
      { key: 'sk-a-1', label: 'personal' },
      { key: 'sk-a-2', label: 'work' },
    ]);
  });

  it('throws when label is duplicate', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n\n[llm.api_keys.anthropic]\nkeys = [\n  { key = "sk-a-1", label = "personal" },\n]\n`
    );
    expect(() =>
      addKeyToApiKeyProvider(configPath, 'anthropic', { key: 'sk-a-2', label: 'personal' })
    ).toThrow(/label "personal" already exists/);
  });

  it('throws when provider sub-section is absent', () => {
    writeFileSync(configPath, `[llm.api_keys]\nprimary = "openai"\nfallback = []\n`);
    expect(() => addKeyToApiKeyProvider(configPath, 'anthropic', { key: 'x', label: 'y' })).toThrow(
      /\[llm\.api_keys\.anthropic\] not found/
    );
  });
});

describe('removeKeyFromApiKeyProvider', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-toml-test-'));
    configPath = join(dir, 'config.toml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes a key by label', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n\n[llm.api_keys.anthropic]\nkeys = [\n  { key = "sk-a-1", label = "personal" },\n  { key = "sk-a-2", label = "work" },\n]\n`
    );
    const result = removeKeyFromApiKeyProvider(configPath, 'anthropic', 'personal');
    expect(result.changed).toBe(true);
    const parsed = TOML.parse(readFileSync(configPath, 'utf-8')) as {
      llm?: { api_keys?: { anthropic?: { keys?: Array<{ key: string; label: string }> } } };
    };
    expect(parsed.llm?.api_keys?.anthropic?.keys).toEqual([{ key: 'sk-a-2', label: 'work' }]);
  });

  it('is a no-op when label not found', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n\n[llm.api_keys.anthropic]\nkeys = [\n  { key = "sk-a-1", label = "personal" },\n]\n`
    );
    const before = readFileSync(configPath, 'utf-8');
    const result = removeKeyFromApiKeyProvider(configPath, 'anthropic', 'missing');
    expect(result.changed).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('throws when removing the last key (caller should remove the provider instead)', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n\n[llm.api_keys.anthropic]\nkeys = [\n  { key = "sk-a-1", label = "personal" },\n]\n`
    );
    expect(() => removeKeyFromApiKeyProvider(configPath, 'anthropic', 'personal')).toThrow(
      /cannot remove the last key/
    );
  });
});

describe('Brave Search patchers', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-toml-test-'));
    configPath = join(dir, 'config.toml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('setBraveSearchKey creates [services.brave_search] and enables [tools.web_search]', () => {
    writeFileSync(configPath, `[llm]\n`);
    const result = setBraveSearchKey(configPath, 'BSK-test-1');
    expect(result.changed).toBe(true);
    const parsed = TOML.parse(readFileSync(configPath, 'utf-8')) as {
      services?: { brave_search?: { key?: string } };
      tools?: { web_search?: { enabled?: boolean; max_results?: number } };
    };
    expect(parsed.services?.brave_search?.key).toBe('BSK-test-1');
    expect(parsed.tools?.web_search?.enabled).toBe(true);
  });

  it('setBraveSearchKey replaces existing key in place', () => {
    writeFileSync(
      configPath,
      `[services.brave_search]\nkey = "OLD"\n\n[tools.web_search]\nenabled = true\nmax_results = 5\n`
    );
    const result = setBraveSearchKey(configPath, 'NEW');
    expect(result.changed).toBe(true);
    const parsed = TOML.parse(readFileSync(configPath, 'utf-8')) as {
      services?: { brave_search?: { key?: string } };
    };
    expect(parsed.services?.brave_search?.key).toBe('NEW');
  });

  it('removeBraveSearch deletes both sections', () => {
    writeFileSync(
      configPath,
      `[services.brave_search]\nkey = "BSK"\n\n[tools.web_search]\nenabled = true\nmax_results = 5\n`
    );
    const result = removeBraveSearch(configPath);
    expect(result.changed).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).not.toMatch(/\[services\.brave_search\]/);
    expect(content).not.toMatch(/\[tools\.web_search\]/);
  });

  it('removeBraveSearch is a no-op when sections absent', () => {
    writeFileSync(configPath, `[llm]\n`);
    const before = readFileSync(configPath, 'utf-8');
    const result = removeBraveSearch(configPath);
    expect(result.changed).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });
});
