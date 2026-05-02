import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addKeyToApiKeyProvider,
  addProviderToApiKeysTier,
  addProviderToOAuthTier,
  escapeTomlString,
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

describe('addProviderToOAuthTier', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-toml-test-'));
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

  it('throws when [llm.oauth] is non-null but the regex does not match (consistency with siblings)', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n\n  [llm.oauth]\n  primary = "google"\n  fallback = []\n`
    );
    expect(() => addProviderToOAuthTier(configPath, 'anthropic')).toThrow(
      /Could not locate \[llm\.oauth\] section/
    );
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
    dir = mkdtempSync(join(tmpdir(), 'system2-toml-test-'));
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

  it('throws when [llm.oauth] is malformed (missing primary)', () => {
    // Regression: without the malformed-tier guard, removing a fallback entry
    // from a primary-less [llm.oauth] would leave newPrimary null and the
    // section-deletion branch fires, wiping the entire block.
    writeFileSync(configPath, `[llm.oauth]\nfallback = ["anthropic", "openai-codex"]\n`);
    expect(() => removeProviderFromOAuthTier(configPath, 'anthropic')).toThrow(
      /\[llm\.oauth\] section exists.*malformed/
    );
    // File untouched.
    expect(readFileSync(configPath, 'utf-8')).toContain('fallback = ["anthropic", "openai-codex"]');
  });
});

describe('setProviderAsPrimary', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-toml-test-'));
    configPath = join(dir, 'config.toml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('promotes a fallback to primary, demoting the previous primary to head of fallback', () => {
    writeFileSync(
      configPath,
      `[llm]\nprimary = "anthropic"\nfallback = []\n\n[llm.oauth]\nprimary = "anthropic"\nfallback = ["openai-codex"]\n\n[llm.anthropic]\nkeys = []\n`
    );
    const result = setProviderAsPrimary(configPath, 'openai-codex');
    expect(result.changed).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toMatch(/primary\s*=\s*"openai-codex"/);
    expect(content).toMatch(/fallback\s*=\s*\[\s*"anthropic"\s*\]/);
  });

  it('preserves the order of remaining fallbacks when promoting', () => {
    writeFileSync(
      configPath,
      `[llm]\nprimary = "anthropic"\nfallback = []\n\n[llm.oauth]\nprimary = "anthropic"\nfallback = ["openai-codex", "github-copilot"]\n\n[llm.anthropic]\nkeys = []\n`
    );
    const result = setProviderAsPrimary(configPath, 'github-copilot');
    expect(result.changed).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toMatch(/primary\s*=\s*"github-copilot"/);
    expect(content).toMatch(/fallback\s*=\s*\[\s*"anthropic"\s*,\s*"openai-codex"\s*\]/);
  });

  it('is a no-op when provider is already primary', () => {
    writeFileSync(
      configPath,
      `[llm]\nprimary = "anthropic"\nfallback = []\n\n[llm.oauth]\nprimary = "anthropic"\nfallback = ["openai-codex"]\n\n[llm.anthropic]\nkeys = []\n`
    );
    const before = readFileSync(configPath, 'utf-8');
    const result = setProviderAsPrimary(configPath, 'anthropic');
    expect(result.changed).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('throws when [llm.oauth] section is missing', () => {
    writeFileSync(configPath, `[llm]\nprimary = "anthropic"\nfallback = []\n`);
    expect(() => setProviderAsPrimary(configPath, 'openai-codex')).toThrow(/not found/);
  });
});

// Regression: the OAuth-rewrite helpers used to capture from `[llm.oauth]`
// up to the next live `[`-section. Once buildConfigToml started emitting
// commented templates and dividers between live sections (commit 9510823),
// that wide span silently consumed the api-keys section, the agents section,
// and the divider header of whatever section came next — and the minimal
// replacement string in setProviderAsPrimary / removeProviderFromOAuthTier
// erased it all. These tests pin the narrow-block behavior.
describe('OAuth rewrites preserve adjacent commented templates and dividers', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-toml-test-'));
    configPath = join(dir, 'config.toml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A toml shaped like buildConfigToml's output for an OAuth-only install:
   *  live [llm.oauth] block followed by commented templates for api-keys
   *  and agents, a Services divider, and a live [services.brave_search]. */
  const tomlWithCommentedTemplates = `# ════════════════════════════════════════════════════════════════════════
# LLM credentials — OAuth tier
# ════════════════════════════════════════════════════════════════════════

[llm.oauth]
primary = "anthropic"
fallback = []

# ════════════════════════════════════════════════════════════════════════
# LLM credentials — API keys tier
# ════════════════════════════════════════════════════════════════════════
# Add API keys to enable as failover when the OAuth tier is exhausted.
# [llm.api_keys]
# primary = "anthropic"
# fallback = []

# ════════════════════════════════════════════════════════════════════════
# Per-agent behavior overrides
# ════════════════════════════════════════════════════════════════════════
# [agents.conductor]
# thinking_level = "high"

# ════════════════════════════════════════════════════════════════════════
# Services
# ════════════════════════════════════════════════════════════════════════
[services.brave_search]
key = "BSAxxx"
`;

  it('addProviderToOAuthTier preserves commented templates and dividers when appending fallback', () => {
    writeFileSync(configPath, tomlWithCommentedTemplates);
    const result = addProviderToOAuthTier(configPath, 'github-copilot');
    expect(result.changed).toBe(true);
    const after = readFileSync(configPath, 'utf-8');
    expect(after).toMatch(
      /\[llm\.oauth\]\s*\nprimary\s*=\s*"anthropic"\s*\nfallback\s*=\s*\[\s*"github-copilot"\s*\]/
    );
    expect(after).toContain('# LLM credentials — API keys tier');
    expect(after).toContain('# [llm.api_keys]');
    expect(after).toContain('# Per-agent behavior overrides');
    expect(after).toContain('# [agents.conductor]');
    expect(after).toContain('# Services');
    expect(after).toContain('[services.brave_search]');
    expect(after).toContain('key = "BSAxxx"');
  });

  it('setProviderAsPrimary preserves commented templates and dividers when promoting', () => {
    writeFileSync(
      configPath,
      tomlWithCommentedTemplates.replace(/fallback = \[\]/, 'fallback = ["github-copilot"]')
    );
    const result = setProviderAsPrimary(configPath, 'github-copilot');
    expect(result.changed).toBe(true);
    const after = readFileSync(configPath, 'utf-8');
    expect(after).toMatch(
      /\[llm\.oauth\]\s*\nprimary\s*=\s*"github-copilot"\s*\nfallback\s*=\s*\[\s*"anthropic"\s*\]/
    );
    expect(after).toContain('# LLM credentials — API keys tier');
    expect(after).toContain('# [llm.api_keys]');
    expect(after).toContain('# Per-agent behavior overrides');
    expect(after).toContain('# Services');
    expect(after).toContain('[services.brave_search]');
  });

  it('removeProviderFromOAuthTier preserves commented templates and dividers when promoting fallback', () => {
    writeFileSync(
      configPath,
      tomlWithCommentedTemplates.replace(/fallback = \[\]/, 'fallback = ["github-copilot"]')
    );
    const result = removeProviderFromOAuthTier(configPath, 'anthropic');
    expect(result.changed).toBe(true);
    const after = readFileSync(configPath, 'utf-8');
    expect(after).toMatch(/primary\s*=\s*"github-copilot"/);
    expect(after).toContain('# LLM credentials — API keys tier');
    expect(after).toContain('# [llm.api_keys]');
    expect(after).toContain('# Per-agent behavior overrides');
    expect(after).toContain('[services.brave_search]');
  });

  it('removeProviderFromOAuthTier drops only [llm.oauth] when removing the last provider', () => {
    writeFileSync(configPath, tomlWithCommentedTemplates);
    const result = removeProviderFromOAuthTier(configPath, 'anthropic');
    expect(result.changed).toBe(true);
    const after = readFileSync(configPath, 'utf-8');
    expect(after).not.toMatch(/^\[llm\.oauth\]/m);
    expect(after).toContain('# LLM credentials — API keys tier');
    expect(after).toContain('# Per-agent behavior overrides');
    expect(after).toContain('[services.brave_search]');
  });
});

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

  it('on stub-replace, lands the live sub-section right after the live tier (not at EOF)', () => {
    // Regression: the live `[llm.api_keys.<provider>]` used to be appended at
    // EOF after the tier-stub-replace, leaving the user with a live tier
    // block near the top of the file and the matching sub-section dozens of
    // lines later — visually disjoint and confusing.
    const fileWithStub =
      `[llm.oauth]\nprimary = "anthropic"\nfallback = []\n\n` +
      `# Add API keys to enable as failover when the OAuth tier is exhausted.\n` +
      `# Uncomment and edit:\n` +
      `# [llm.api_keys]\n# primary = "anthropic"\n# fallback = ["google", "openai"]\n` +
      `#\n` +
      `# [llm.api_keys.anthropic]\n# keys = [\n#   { key = "sk-ant-...", label = "default" },\n# ]\n` +
      `\n# === Other operational sections ===\n# [backup]\n# cooldown_hours = 24\n`;
    writeFileSync(configPath, fileWithStub);
    addProviderToApiKeysTier(configPath, 'google', [{ key: 'AIzaSyXYZ', label: 'default' }]);
    const content = readFileSync(configPath, 'utf-8');
    // Live tier is followed by the live sub-section (with at most a blank
    // line between them), NOT at EOF after the operational sections.
    expect(content).toMatch(
      /\[llm\.api_keys\]\nprimary = "google"\nfallback = \[\]\n\n\[llm\.api_keys\.google\]\n/
    );
    // The commented anthropic example stays as documentation (different provider).
    expect(content).toMatch(/^# \[llm\.api_keys\.anthropic\]/m);
    // Operational sections still after the live blocks (untouched).
    const apiKeysIdx = content.indexOf('[llm.api_keys.google]');
    const backupIdx = content.indexOf('# [backup]');
    expect(apiKeysIdx).toBeGreaterThan(-1);
    expect(backupIdx).toBeGreaterThan(apiKeysIdx);
  });

  it('places the new sub-section adjacent to existing live sub-sections, not at EOF', () => {
    // Regression: when `[llm.api_keys]` already had a live sub-section and the
    // user added a SECOND provider, the new sub-section was appended at EOF
    // (often far below operational sections), visually disjoint from the
    // existing sub-sections it logically belongs with.
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "openai"\nfallback = []\n\n[llm.api_keys.openai]\nkeys = [\n  { key = "sk-1", label = "default" },\n]\n\n# === operational sections ===\n# [backup]\n# cooldown_hours = 24\n`
    );
    addProviderToApiKeysTier(configPath, 'anthropic', [{ key: 'sk-ant', label: 'default' }]);
    const content = readFileSync(configPath, 'utf-8');
    // Both live sub-sections appear ahead of the operational sections.
    const openaiIdx = content.indexOf('[llm.api_keys.openai]');
    const anthropicIdx = content.indexOf('[llm.api_keys.anthropic]');
    const backupIdx = content.indexOf('# [backup]');
    expect(openaiIdx).toBeGreaterThan(-1);
    expect(anthropicIdx).toBeGreaterThan(openaiIdx);
    expect(backupIdx).toBeGreaterThan(anthropicIdx);
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

  it('repairs an "in tier but missing sub-section" state without touching tier order', () => {
    // Regression: a hand-edit could leave a provider in [llm.api_keys].fallback
    // without a [llm.api_keys.<provider>] sub-section. Previously,
    // addProviderToApiKeysTier threw "already in [llm.api_keys]" with no
    // recovery path. Now the patcher detects the inTier-but-no-sub-section
    // state and writes the missing sub-section in place, preserving the
    // existing primary/fallback order.
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "openai"\nfallback = ["anthropic"]\n\n[llm.api_keys.openai]\nkeys = [\n  { key = "sk-1", label = "default" },\n]\n`
    );
    const result = addProviderToApiKeysTier(configPath, 'anthropic', [
      { key: 'sk-ant', label: 'default' },
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
    // Tier order untouched; sub-section now present.
    expect(parsed.llm?.api_keys?.primary).toBe('openai');
    expect(parsed.llm?.api_keys?.fallback).toEqual(['anthropic']);
    expect(parsed.llm?.api_keys?.anthropic?.keys).toEqual([{ key: 'sk-ant', label: 'default' }]);
  });

  it('rejects empty keys array, empty key/label fields, and duplicate labels', () => {
    writeFileSync(configPath, `[llm]\n`);
    // Empty array.
    expect(() => addProviderToApiKeysTier(configPath, 'anthropic', [])).toThrow(
      /keys array is empty/
    );
    // Empty key.
    expect(() =>
      addProviderToApiKeysTier(configPath, 'anthropic', [{ key: '', label: 'x' }])
    ).toThrow(/empty key value/);
    // Empty label.
    expect(() =>
      addProviderToApiKeysTier(configPath, 'anthropic', [{ key: 'sk-1', label: '' }])
    ).toThrow(/empty label/);
    // Duplicate label.
    expect(() =>
      addProviderToApiKeysTier(configPath, 'anthropic', [
        { key: 'sk-1', label: 'main' },
        { key: 'sk-2', label: 'main' },
      ])
    ).toThrow(/duplicate label "main"/);
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

  it('setBraveSearchKey forces enabled = true when [tools.web_search] exists with enabled = false', () => {
    // Regression: previously, the patcher only ADDED the section when missing,
    // so a pre-existing `enabled = false` left web search off even though the
    // caller logs "web search tool enabled".
    writeFileSync(
      configPath,
      `[services.brave_search]\nkey = "OLD"\n\n[tools.web_search]\nenabled = false\nmax_results = 5\n`
    );
    setBraveSearchKey(configPath, 'NEW');
    const parsed = TOML.parse(readFileSync(configPath, 'utf-8')) as {
      tools?: { web_search?: { enabled?: boolean; max_results?: number } };
    };
    expect(parsed.tools?.web_search?.enabled).toBe(true);
    // Other fields preserved.
    expect(parsed.tools?.web_search?.max_results).toBe(5);
  });

  it('setBraveSearchKey adds enabled = true when [tools.web_search] exists with no enabled line', () => {
    writeFileSync(
      configPath,
      `[services.brave_search]\nkey = "OLD"\n\n[tools.web_search]\nmax_results = 7\n`
    );
    setBraveSearchKey(configPath, 'NEW');
    const parsed = TOML.parse(readFileSync(configPath, 'utf-8')) as {
      tools?: { web_search?: { enabled?: boolean; max_results?: number } };
    };
    expect(parsed.tools?.web_search?.enabled).toBe(true);
    expect(parsed.tools?.web_search?.max_results).toBe(7);
  });

  it('setBraveSearchKey replaces the commented-stub blocks instead of appending at EOF', () => {
    // Regression: previously, when the file contained the commented stubs
    // buildConfigToml emits (`# [services.brave_search]\n# key = "BSA..."` and
    // `# [tools.web_search]\n# enabled = true\n# max_results = 5`), setBraveSearchKey
    // appended live blocks at EOF and left the stubs in place — confusing duplicate
    // schema. Now: detect each stub and replace in place, mirroring the OAuth /
    // api-keys patcher stub-replacement behaviour.
    writeFileSync(
      configPath,
      `[llm.oauth]\nprimary = "anthropic"\nfallback = []\n\n# [services.brave_search]\n# key = "BSA..."\n\n# [tools.web_search]\n# enabled = true\n# max_results = 5\n`
    );
    setBraveSearchKey(configPath, 'BSK-real-key');
    const content = readFileSync(configPath, 'utf-8');
    // Stubs are gone (no commented `# [services.brave_search]` or `# [tools.web_search]`).
    expect(content).not.toMatch(/^# \[services\.brave_search\]/m);
    expect(content).not.toMatch(/^# \[tools\.web_search\]/m);
    // Live blocks present and parse cleanly.
    const parsed = TOML.parse(content) as {
      services?: { brave_search?: { key?: string } };
      tools?: { web_search?: { enabled?: boolean } };
    };
    expect(parsed.services?.brave_search?.key).toBe('BSK-real-key');
    expect(parsed.tools?.web_search?.enabled).toBe(true);
    // Exactly one live block per section — the stub-replace path didn't also
    // append at EOF.
    expect(content.match(/^\[services\.brave_search\]/gm)).toHaveLength(1);
    expect(content.match(/^\[tools\.web_search\]/gm)).toHaveLength(1);
  });

  it('setBraveSearchKey preserves the # max_results commented hint when stub-replacing', () => {
    // Regression: an earlier version of the stub-replace path stripped the
    // `# max_results = 5` line entirely, leaving the user with no visible
    // reference to the tunable. Now the line is preserved (still commented,
    // so the loader's default propagates) so users can see/uncomment it.
    writeFileSync(
      configPath,
      `[llm.oauth]\nprimary = "anthropic"\nfallback = []\n\n# [services.brave_search]\n# key = "BSA..."\n\n# [tools.web_search]\n# enabled = true\n# max_results = 5\n`
    );
    setBraveSearchKey(configPath, 'BSK-real-key');
    const content = readFileSync(configPath, 'utf-8');
    // Live web_search block contains enabled = true and the max_results hint.
    expect(content).toMatch(/^\[tools\.web_search\]\nenabled = true\n# max_results = 5$/m);
  });

  it('setBraveSearchKey emits the # max_results hint on the EOF-append path too', () => {
    // Parity check: when there's no commented stub (e.g. a hand-written
    // partial config), the EOF-append path should still include the hint
    // so users are exposed to the tunable consistently.
    writeFileSync(configPath, `[llm]\n`);
    setBraveSearchKey(configPath, 'BSK-1');
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toMatch(/\[tools\.web_search\]\nenabled = true\n# max_results = 5\n/);
  });

  it('setBraveSearchKey handles a comment-only [services.brave_search] body without duplicating', () => {
    // Regression: a section with only commented body lines (e.g. user has
    // `[services.brave_search]\n# key = "..."` from prior hand-editing —
    // valid TOML, empty table) bypassed both the live regex (requires
    // non-comment body) and the header-only regex (requires no body at
    // all). Previously fell through to EOF append → duplicate-table TOML.
    writeFileSync(
      configPath,
      `[llm.oauth]\nprimary = "anthropic"\nfallback = []\n\n[services.brave_search]\n# key = "OLD-COMMENTED"\n\n[tools.web_search]\n# enabled = false\n`
    );
    setBraveSearchKey(configPath, 'BSK-NEW');
    const content = readFileSync(configPath, 'utf-8');
    // Exactly one of each header (no duplicates); file parses cleanly.
    expect(content.match(/^\[services\.brave_search\]/gm)).toHaveLength(1);
    expect(content.match(/^\[tools\.web_search\]/gm)).toHaveLength(1);
    const parsed = TOML.parse(content) as {
      services?: { brave_search?: { key?: string } };
      tools?: { web_search?: { enabled?: boolean } };
    };
    expect(parsed.services?.brave_search?.key).toBe('BSK-NEW');
    expect(parsed.tools?.web_search?.enabled).toBe(true);
    // Original commented hint dropped (replaced by the live key); commented
    // `# enabled = false` also gone because we inserted `enabled = true`
    // immediately after the header. Both behaviors match the line-based
    // section-rewrite contract.
  });

  it('setBraveSearchKey handles header-only [services.brave_search] / [tools.web_search] without duplicating headers', () => {
    // Regression: BRAVE/WEB_SEARCH_SECTION_PATTERN require at least one
    // key=value line after the header. A bare `[services.brave_search]` /
    // `[tools.web_search]` (no body) bypassed that pattern, fell through to
    // stub or EOF append, and produced two headers — duplicate-table TOML.
    writeFileSync(
      configPath,
      `[llm.oauth]\nprimary = "anthropic"\nfallback = []\n\n[services.brave_search]\n\n[tools.web_search]\n`
    );
    setBraveSearchKey(configPath, 'BSK-1');
    const content = readFileSync(configPath, 'utf-8');
    // Exactly one of each header (no duplicates); file parses cleanly.
    expect(content.match(/^\[services\.brave_search\]/gm)).toHaveLength(1);
    expect(content.match(/^\[tools\.web_search\]/gm)).toHaveLength(1);
    const parsed = TOML.parse(content) as {
      services?: { brave_search?: { key?: string } };
      tools?: { web_search?: { enabled?: boolean } };
    };
    expect(parsed.services?.brave_search?.key).toBe('BSK-1');
    expect(parsed.tools?.web_search?.enabled).toBe(true);
  });

  it('setBraveSearchKey rewrites a non-boolean enabled (e.g. enabled = "false") without duplicating', () => {
    // Regression: the prior `[a-zA-Z]+` value matcher missed string,
    // numeric, or other hand-edited values. The rewrite branch missed,
    // the no-line branch fired, and we inserted a duplicate `enabled`
    // key — which TOML parsers reject. The broadened `[^\n#]+` value
    // matcher rewrites all of these to a single canonical line.
    writeFileSync(
      configPath,
      `[services.brave_search]\nkey = "OLD"\n\n[tools.web_search]\nenabled = "false"\nmax_results = 5\n`
    );
    setBraveSearchKey(configPath, 'NEW');
    const content = readFileSync(configPath, 'utf-8');
    // Exactly one `enabled = …` line; file parses cleanly.
    expect(content.match(/^enabled\s*=/gm)).toHaveLength(1);
    const parsed = TOML.parse(content) as {
      tools?: { web_search?: { enabled?: boolean; max_results?: number } };
    };
    expect(parsed.tools?.web_search?.enabled).toBe(true);
    expect(parsed.tools?.web_search?.max_results).toBe(5);
  });

  it('setBraveSearchKey rewrites enabled with trailing inline comment without duplicating the key', () => {
    // Regression: the previous regex required the line to end at \s*$ so a
    // trailing inline comment caused the rewrite branch to miss; the no-line
    // branch then fired and inserted a second `enabled = true` line, producing
    // duplicate keys (invalid TOML, throws on parse).
    writeFileSync(
      configPath,
      `[services.brave_search]\nkey = "OLD"\n\n[tools.web_search]\nenabled = false  # disabled for now\nmax_results = 5\n`
    );
    setBraveSearchKey(configPath, 'NEW');
    const content = readFileSync(configPath, 'utf-8');
    // Exactly one `enabled = …` line; comment dropped (intentional, the rewrite
    // replaces the whole line) but max_results preserved.
    const enabledMatches = content.match(/^enabled\s*=/gm) ?? [];
    expect(enabledMatches).toHaveLength(1);
    const parsed = TOML.parse(content) as {
      tools?: { web_search?: { enabled?: boolean; max_results?: number } };
    };
    expect(parsed.tools?.web_search?.enabled).toBe(true);
    expect(parsed.tools?.web_search?.max_results).toBe(5);
  });
});

describe('escapeTomlString', () => {
  it('passes simple ASCII through unchanged', () => {
    expect(escapeTomlString('sk-ant-1234')).toBe('sk-ant-1234');
    expect(escapeTomlString('http://localhost:4000/v1')).toBe('http://localhost:4000/v1');
  });

  it('escapes backslash before doubling other escapes', () => {
    // Backslash MUST be escaped first or each later substitution that introduces
    // a backslash gets re-escaped on the next pass.
    expect(escapeTomlString('a\\b')).toBe('a\\\\b');
    expect(escapeTomlString('foo"bar')).toBe('foo\\"bar');
  });

  it('escapes newline / tab / carriage return', () => {
    expect(escapeTomlString('line1\nline2')).toBe('line1\\nline2');
    expect(escapeTomlString('a\tb')).toBe('a\\tb');
    expect(escapeTomlString('a\rb')).toBe('a\\rb');
  });

  it('escapes C0 control chars (and DEL) as \\uXXXX', () => {
    // Per TOML spec, raw control chars are illegal in basic strings. The
    // catch-all in escapeTomlString must produce \uXXXX escapes for any C0
    // control or DEL not already named (\b, \t, \n, \f, \r are special-cased).
    expect(escapeTomlString('a b')).toBe('a\\u0000b');
    expect(escapeTomlString('ab')).toBe('a\\u0001b');
    expect(escapeTomlString('ab')).toBe('a\\u001fb');
    expect(escapeTomlString('ab')).toBe('a\\u007fb');
    // The escape round-trips through @iarna/toml back to the original char.
    const toml = `[t]\nkey = "${escapeTomlString('ab')}"\n`;
    const parsed = TOML.parse(toml) as { t?: { key?: string } };
    expect(parsed.t?.key).toBe('ab');
  });

  it('produces TOML that round-trips through TOML.parse without injection', () => {
    // Adversarial label: closing quote + injecting another key/value.
    const malicious = 'normal", primary = "evil';
    const escaped = escapeTomlString(malicious);
    const toml = `[t]\nkey = "${escaped}"\n`;
    const parsed = TOML.parse(toml) as { t?: { key?: string; primary?: string } };
    expect(parsed.t?.key).toBe(malicious);
    expect(parsed.t?.primary).toBeUndefined();
  });
});

describe('replaceKeyInApiKeyProvider', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-toml-test-'));
    configPath = join(dir, 'config.toml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces a key by label without touching tier order', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = ["openai"]\n\n[llm.api_keys.anthropic]\nkeys = [\n  { key = "old-1", label = "personal" },\n  { key = "k-2", label = "work" },\n]\n\n[llm.api_keys.openai]\nkeys = [\n  { key = "sk-o", label = "default" },\n]\n`
    );
    const result = replaceKeyInApiKeyProvider(configPath, 'anthropic', 'personal', 'new-1');
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
    // Tier order untouched.
    expect(parsed.llm?.api_keys?.primary).toBe('anthropic');
    expect(parsed.llm?.api_keys?.fallback).toEqual(['openai']);
    // Key swapped, others preserved.
    expect(parsed.llm?.api_keys?.anthropic?.keys).toEqual([
      { key: 'new-1', label: 'personal' },
      { key: 'k-2', label: 'work' },
    ]);
  });

  it('preserves tier order even when the provider has only one key', () => {
    // Regression for the previous remove+add dance, which would have promoted
    // a fallback to primary in this scenario.
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = ["openai"]\n\n[llm.api_keys.anthropic]\nkeys = [\n  { key = "old", label = "default" },\n]\n\n[llm.api_keys.openai]\nkeys = [\n  { key = "sk-o", label = "default" },\n]\n`
    );
    const result = replaceKeyInApiKeyProvider(configPath, 'anthropic', 'default', 'new');
    expect(result.changed).toBe(true);
    const parsed = TOML.parse(readFileSync(configPath, 'utf-8')) as {
      llm?: { api_keys?: { primary?: string; fallback?: string[] } };
    };
    expect(parsed.llm?.api_keys?.primary).toBe('anthropic');
    expect(parsed.llm?.api_keys?.fallback).toEqual(['openai']);
  });

  it('is a no-op when the new key matches the existing one', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n\n[llm.api_keys.anthropic]\nkeys = [\n  { key = "same", label = "default" },\n]\n`
    );
    const before = readFileSync(configPath, 'utf-8');
    const result = replaceKeyInApiKeyProvider(configPath, 'anthropic', 'default', 'same');
    expect(result.changed).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('throws when label is not found', () => {
    writeFileSync(
      configPath,
      `[llm.api_keys]\nprimary = "anthropic"\nfallback = []\n\n[llm.api_keys.anthropic]\nkeys = [\n  { key = "k", label = "default" },\n]\n`
    );
    expect(() => replaceKeyInApiKeyProvider(configPath, 'anthropic', 'missing', 'x')).toThrow(
      /label "missing" not found/
    );
  });
});
