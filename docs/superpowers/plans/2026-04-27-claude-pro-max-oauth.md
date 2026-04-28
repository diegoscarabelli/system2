# Claude Pro/Max OAuth Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separate OAuth auth tier to system2, with Claude Pro/Max OAuth as the only v1 OAuth provider. The OAuth tier is fully exhausted (cooldown on every OAuth credential) before falling over to the existing API key tier. If OAuth is not configured, system2 behaves exactly as today.

**Architecture:** Two ordered auth tiers in `AuthResolver`:
- **OAuth tier** (`[llm.oauth].primary` + `fallback`): subscription credentials, tried first.
- **API key tier** (`[llm].primary` + `fallback`): billed per-token, used after OAuth tier is exhausted.

Failover walks the OAuth tier first; only when every OAuth credential is in cooldown does it drop into the API key tier — never interleaving. OAuth credentials live in `~/.system2/oauth/<provider>.json` (mode 0600), one file per provider, refreshed automatically before each session creation. The pi-ai SDK already supports Anthropic OAuth (substring match `sk-ant-oat` switches the SDK to Bearer auth + Claude Code identity headers + tool-name remapping), so no SDK fork is needed. The agent loop, custom tools, and multi-agent orchestration all stay intact.

**Tech Stack:** TypeScript, `@mariozechner/pi-ai` (`loginAnthropic`, `refreshAnthropicToken`), `@iarna/toml`, `@clack/prompts`, `vitest`.

---

## File Structure

**Created:**
- `src/server/agents/oauth-credentials.ts` — load/save `~/.system2/oauth/<provider>.json` (mode 0600). Parameterized by provider for future expansion (pi-ai also supports Google Gemini CLI, GitHub Copilot, OpenAI Codex OAuth).
- `src/server/agents/oauth-credentials.test.ts`
- `src/server/agents/oauth.ts` — wraps pi-ai's `loginAnthropic` and `refreshAnthropicToken`. Re-exports `loginAnthropic` for onboarding. Adds `isExpiringSoon()`.
- `src/server/agents/oauth.test.ts`

**Modified:**
- `src/shared/types/config.ts` — add `LlmOAuthConfig`; add `oauth?: LlmOAuthConfig` to `LlmConfig`.
- `src/cli/utils/config.ts` — TOML round-trip for `[llm.oauth]` section.
- `src/cli/commands/onboard.ts` — two-step onboarding: OAuth tier first (optional), API key tier second (optional). At least one tier required.
- `src/server/agents/auth-resolver.ts` — two-tier credential model. Cooldown keys become `${tier}:${provider}:${keyIndex}`. New `getActiveCredential()` returns tier-tagged result. Tier cursor advances to keys tier when OAuth tier exhausted.
- `src/server/agents/auth-resolver.test.ts`
- `src/server/agents/host.ts` — track `currentTier`; call `ensureFresh()` before session creation; refresh-and-retry once on 401 from OAuth tier credential.
- `src/server/agents/host.test.ts`
- `src/server/server.ts` — load OAuth credentials at startup for each provider in `[llm.oauth]`; wire persist callbacks.
- `docs/configuration.md` — document `[llm.oauth]` section, credentials files, refresh, two-tier failover.
- `docs/agents.md` — document two-tier AuthResolver.

---

## Task 1: Add `LlmOAuthConfig` type

**Files:**
- Modify: `src/shared/types/config.ts:32-36`

- [ ] **Step 1: Add the type**

In `src/shared/types/config.ts`, after the existing `LlmConfig` interface, add:

```typescript
export interface LlmOAuthConfig {
  primary: LlmProvider;
  fallback: LlmProvider[];
}
```

Then extend `LlmConfig`:

```typescript
export interface LlmConfig {
  primary: LlmProvider;
  fallback: LlmProvider[];
  providers: Partial<Record<LlmProvider, LlmProviderConfig>>;
  /** Optional OAuth tier. When present, OAuth credentials are tried before API keys. */
  oauth?: LlmOAuthConfig;
}
```

`LlmKey` and `LlmProviderConfig` are unchanged from today — OAuth credentials live outside `LlmKey`, in their own data structure.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/config.ts
git commit -m "feat(config): add LlmOAuthConfig type for OAuth tier"
```

---

## Task 2: TOML round-trip for `[llm.oauth]`

**Files:**
- Modify: `src/cli/utils/config.ts:74-94` (TomlConfig), `:183-248` (`convertTomlLlm`), `:543-599` (`buildConfigToml`)
- Test: `src/cli/utils/config.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/cli/utils/config.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import TOML from '@iarna/toml';
import type { LlmConfig } from '../../shared/index.js';
import { buildConfigToml } from './config.js';

describe('buildConfigToml — [llm.oauth] tier', () => {
  it('emits oauth section with primary and fallback', () => {
    const llm: LlmConfig = {
      primary: 'anthropic',
      fallback: [],
      providers: { anthropic: { keys: [] } },
      oauth: { primary: 'anthropic', fallback: [] },
    };
    const toml = buildConfigToml({ llm });
    expect(toml).toMatch(/\[llm\.oauth\]\s*\nprimary\s*=\s*"anthropic"\s*\nfallback\s*=\s*\[\]/);
  });

  it('omits oauth section when undefined', () => {
    const llm: LlmConfig = {
      primary: 'anthropic',
      fallback: [],
      providers: { anthropic: { keys: [{ key: 'k', label: 'l' }] } },
    };
    const toml = buildConfigToml({ llm });
    expect(toml).not.toMatch(/\[llm\.oauth\]/);
  });

  it('round-trips through TOML.parse', () => {
    const llm: LlmConfig = {
      primary: 'openai',
      fallback: ['google'],
      providers: {
        anthropic: { keys: [] },
        openai: { keys: [{ key: 'oai-1', label: 'main' }] },
      },
      oauth: { primary: 'anthropic', fallback: [] },
    };
    const toml = buildConfigToml({ llm });
    const parsed = TOML.parse(toml) as { llm?: { oauth?: { primary?: string; fallback?: string[] } } };
    expect(parsed.llm?.oauth?.primary).toBe('anthropic');
    expect(parsed.llm?.oauth?.fallback).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/cli/utils/config.test.ts`
Expected: FAIL — no oauth section emitted yet.

- [ ] **Step 3: Update `TomlConfig` interface**

In `src/cli/utils/config.ts:74-94`, add to the `llm` block:

```typescript
    oauth?: {
      primary?: string;
      fallback?: string[];
    };
```

- [ ] **Step 4: Update `convertTomlLlm` to read oauth**

In `src/cli/utils/config.ts:243-247`, change the return statement:

```typescript
  const config: LlmConfig = {
    primary: (toml.primary as LlmProvider) ?? 'anthropic',
    fallback: (toml.fallback as LlmProvider[]) ?? [],
    providers,
  };

  if (toml.oauth?.primary) {
    config.oauth = {
      primary: toml.oauth.primary as LlmProvider,
      fallback: (toml.oauth.fallback as LlmProvider[]) ?? [],
    };
  }

  return config;
```

- [ ] **Step 5: Update `buildConfigToml` to emit oauth**

In `src/cli/utils/config.ts`, after the `[llm]` section header (around line 549, after `lines.push('');`), insert:

```typescript
    if (options.llm.oauth) {
      lines.push('[llm.oauth]');
      lines.push(`primary = "${options.llm.oauth.primary}"`);
      const fb = options.llm.oauth.fallback.map((f) => `"${f}"`).join(', ');
      lines.push(`fallback = [${fb}]`);
      lines.push('');
    }
```

- [ ] **Step 6: Run tests**

Run: `pnpm test src/cli/utils/config.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 7: Run full check**

Run: `pnpm check && pnpm typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/cli/utils/config.ts src/cli/utils/config.test.ts
git commit -m "feat(config): support [llm.oauth] section in TOML round-trip"
```

---

## Task 3: OAuth credentials file storage (provider-parameterized)

**Files:**
- Create: `src/server/agents/oauth-credentials.ts`
- Test: `src/server/agents/oauth-credentials.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/agents/oauth-credentials.test.ts`:

```typescript
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOAuthCredentials, saveOAuthCredentials } from './oauth-credentials.js';

describe('oauth-credentials', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'system2-oauth-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when credentials file does not exist', () => {
    expect(loadOAuthCredentials(dir, 'anthropic')).toBeNull();
  });

  it('round-trips credentials per provider', () => {
    const creds = {
      access: 'sk-ant-oat-abc',
      refresh: 'rt-xyz',
      expires: 1714680000000,
      label: 'claude-pro',
    };
    saveOAuthCredentials(dir, 'anthropic', creds);
    expect(loadOAuthCredentials(dir, 'anthropic')).toEqual(creds);
    expect(loadOAuthCredentials(dir, 'openai')).toBeNull();
  });

  it('writes file with mode 0600', () => {
    saveOAuthCredentials(dir, 'anthropic', { access: 'a', refresh: 'b', expires: 1, label: 'l' });
    const mode = statSync(join(dir, 'oauth', 'anthropic.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns null when file is corrupt JSON', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(dir, 'oauth'), { recursive: true });
    writeFileSync(join(dir, 'oauth', 'anthropic.json'), '{not json');
    expect(loadOAuthCredentials(dir, 'anthropic')).toBeNull();
  });

  it('returns null when file is missing required fields', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(dir, 'oauth'), { recursive: true });
    writeFileSync(join(dir, 'oauth', 'anthropic.json'), JSON.stringify({ access: 'a' }));
    expect(loadOAuthCredentials(dir, 'anthropic')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/server/agents/oauth-credentials.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement the module**

Create `src/server/agents/oauth-credentials.ts`:

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmProvider } from '../../shared/index.js';
import { log } from '../utils/logger.js';

export interface OAuthCredentials {
  access: string;
  refresh: string;
  /** Epoch ms when access token expires (already includes pi-ai's 5 min safety buffer). */
  expires: number;
  label: string;
}

const OAUTH_DIR = 'oauth';

function credentialsPath(system2Dir: string, provider: LlmProvider): string {
  return join(system2Dir, OAUTH_DIR, `${provider}.json`);
}

export function loadOAuthCredentials(
  system2Dir: string,
  provider: LlmProvider
): OAuthCredentials | null {
  const path = credentialsPath(system2Dir, provider);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as OAuthCredentials;
    if (
      typeof parsed.access !== 'string' ||
      typeof parsed.refresh !== 'string' ||
      typeof parsed.expires !== 'number' ||
      typeof parsed.label !== 'string'
    ) {
      log.warn(`[oauth-credentials] ${provider}.json missing required fields, ignoring`);
      return null;
    }
    return parsed;
  } catch (err) {
    log.warn(`[oauth-credentials] Failed to parse ${provider}.json:`, err);
    return null;
  }
}

export function saveOAuthCredentials(
  system2Dir: string,
  provider: LlmProvider,
  credentials: OAuthCredentials
): void {
  const dir = join(system2Dir, OAUTH_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(credentialsPath(system2Dir, provider), JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  });
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/server/agents/oauth-credentials.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/agents/oauth-credentials.ts src/server/agents/oauth-credentials.test.ts
git commit -m "feat(oauth): add per-provider OAuth credentials file storage"
```

---

## Task 4: OAuth refresh helper

**Files:**
- Create: `src/server/agents/oauth.ts`
- Test: `src/server/agents/oauth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/agents/oauth.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { isExpiringSoon } from './oauth.js';

describe('isExpiringSoon', () => {
  it('returns true when expires is within buffer', () => {
    expect(isExpiringSoon(Date.now() + 60_000, 5 * 60_000)).toBe(true);
  });

  it('returns false when expires is well in the future', () => {
    expect(isExpiringSoon(Date.now() + 60 * 60_000, 5 * 60_000)).toBe(false);
  });

  it('returns true when already expired', () => {
    expect(isExpiringSoon(Date.now() - 1000, 5 * 60_000)).toBe(true);
  });

  it('uses default buffer when not provided', () => {
    expect(isExpiringSoon(Date.now() + 60_000)).toBe(true);
    expect(isExpiringSoon(Date.now() + 60 * 60_000)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/server/agents/oauth.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement the module**

Create `src/server/agents/oauth.ts`:

```typescript
import { loginAnthropic, refreshAnthropicToken } from '@mariozechner/pi-ai';

/** How close to expiry we trigger a refresh. pi-ai's expires already includes a 5min buffer; we add another 5. */
export const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface RefreshedTokens {
  access: string;
  refresh: string;
  expires: number;
}

export function isExpiringSoon(expires: number, bufferMs: number = REFRESH_BUFFER_MS): boolean {
  return Date.now() + bufferMs >= expires;
}

/**
 * Refresh the Anthropic OAuth access token via the SDK.
 * Throws on network/auth failure.
 */
export async function refreshAnthropic(refreshToken: string): Promise<RefreshedTokens> {
  const updated = await refreshAnthropicToken(refreshToken);
  return {
    access: updated.access,
    refresh: updated.refresh,
    expires: updated.expires,
  };
}

export { loginAnthropic };
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/server/agents/oauth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/agents/oauth.ts src/server/agents/oauth.test.ts
git commit -m "feat(oauth): add refresh helper wrapping pi-ai SDK"
```

---

## Task 5: AuthResolver — two-tier credential model

**Files:**
- Modify: `src/server/agents/auth-resolver.ts` (substantial refactor)
- Test: `src/server/agents/auth-resolver.test.ts`

This task introduces tier-aware cooldowns and a new `getActiveCredential()` method. Existing callers (`host.ts`) keep using `getActiveKey(provider)`, `markKeyFailed`, `getNextProvider`, but those methods now respect the global tier cursor.

- [ ] **Step 1: Write the failing tests**

Append to `src/server/agents/auth-resolver.test.ts`:

```typescript
import { loadOAuthCredentials, saveOAuthCredentials, type OAuthCredentials } from './oauth-credentials.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeTwoTierConfig(): LlmConfig {
  return {
    primary: 'anthropic',
    fallback: ['openai'],
    providers: {
      anthropic: {
        keys: [
          { key: 'ant-key-1', label: 'main' },
          { key: 'ant-key-2', label: 'backup' },
        ],
      },
      openai: { keys: [{ key: 'oai-key-1', label: 'main' }] },
    },
    oauth: { primary: 'anthropic', fallback: [] },
  };
}

function makeOAuthCreds(expiresInMs: number = 60 * 60_000): OAuthCredentials {
  return {
    access: 'sk-ant-oat-abc',
    refresh: 'rt-xyz',
    expires: Date.now() + expiresInMs,
    label: 'claude-pro',
  };
}

describe('AuthResolver — two-tier model', () => {
  it('returns OAuth credential as active when oauth tier configured', () => {
    const resolver = new AuthResolver(makeTwoTierConfig(), undefined, {
      anthropic: makeOAuthCreds(),
    });
    const active = resolver.getActiveCredential();
    expect(active?.tier).toBe('oauth');
    expect(active?.provider).toBe('anthropic');
    expect(active?.label).toBe('claude-pro');
  });

  it('falls back to keys tier when oauth tier is omitted', () => {
    const cfg = makeTwoTierConfig();
    delete cfg.oauth;
    const resolver = new AuthResolver(cfg);
    const active = resolver.getActiveCredential();
    expect(active?.tier).toBe('keys');
    expect(active?.provider).toBe('anthropic');
    expect(active?.label).toBe('main');
  });

  it('falls back to keys tier when oauth credentials are missing', () => {
    const resolver = new AuthResolver(makeTwoTierConfig());
    const active = resolver.getActiveCredential();
    expect(active?.tier).toBe('keys');
  });

  it('exhausts oauth tier before dropping to keys tier', () => {
    const resolver = new AuthResolver(makeTwoTierConfig(), undefined, {
      anthropic: makeOAuthCreds(),
    });
    resolver.markKeyFailed('anthropic', 'auth', 'invalid_grant', 0, 'oauth');
    const active = resolver.getActiveCredential();
    expect(active?.tier).toBe('keys');
    expect(active?.provider).toBe('anthropic');
    expect(active?.label).toBe('main');
  });

  it('cooldown keys for same provider in different tiers do not collide', () => {
    const resolver = new AuthResolver(makeTwoTierConfig(), undefined, {
      anthropic: makeOAuthCreds(),
    });
    resolver.markKeyFailed('anthropic', 'auth', 'oauth fail', 0, 'oauth');
    expect(resolver.isKeyInCooldown('anthropic', 0, 'oauth')).toBe(true);
    expect(resolver.isKeyInCooldown('anthropic', 0, 'keys')).toBe(false);
  });

  it('walks oauth fallback before dropping to keys tier', () => {
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'anthropic', fallback: ['openai'] },
    };
    const resolver = new AuthResolver(cfg, undefined, {
      anthropic: makeOAuthCreds(),
      openai: { ...makeOAuthCreds(), label: 'codex' },
    });
    resolver.markKeyFailed('anthropic', 'auth', 'fail', 0, 'oauth');
    const active = resolver.getActiveCredential();
    expect(active?.tier).toBe('oauth');
    expect(active?.provider).toBe('openai');
  });

  it('providerOrder includes both tiers, deduplicated', () => {
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'anthropic', fallback: [] },
    };
    const resolver = new AuthResolver(cfg, undefined, { anthropic: makeOAuthCreds() });
    expect(resolver.providerOrder).toEqual(['anthropic', 'openai']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/server/agents/auth-resolver.test.ts -t "two-tier"`
Expected: FAIL

- [ ] **Step 3: Refactor AuthResolver**

In `src/server/agents/auth-resolver.ts`, add the following imports:

```typescript
import type { OAuthCredentials } from './oauth-credentials.js';
```

Add new types near the top of the file:

```typescript
export type AuthTier = 'oauth' | 'keys';

export interface ActiveCredential {
  tier: AuthTier;
  provider: LlmProvider;
  keyIndex: number;
  label: string;
}

export type OAuthCredentialsMap = Partial<Record<LlmProvider, OAuthCredentials>>;
```

Replace the existing `ActiveKey` interface with the new tier-aware one (`ActiveCredential` above) for clarity in callers.

Update the constructor:

```typescript
  private oauthCredentials: OAuthCredentialsMap;
  private oauthOrder: LlmProvider[];
  private keysOrder: LlmProvider[];

  constructor(
    llmConfig: LlmConfig,
    cooldownConfig?: Partial<CooldownConfig>,
    oauthCredentials?: OAuthCredentialsMap
  ) {
    this.config = this.validateConfig(llmConfig);
    this.cooldownConfig = {
      rateLimitMs: cooldownConfig?.rateLimitMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
      defaultMs: cooldownConfig?.defaultMs ?? DEFAULT_COOLDOWN_MS,
    };
    this.oauthCredentials = oauthCredentials ?? {};

    this.oauthOrder = this.config.oauth
      ? [this.config.oauth.primary, ...this.config.oauth.fallback].filter(
          (p) => this.oauthCredentials[p] !== undefined
        )
      : [];
    this.keysOrder = [this.config.primary, ...this.config.fallback];

    for (const provider of Object.keys(this.config.providers) as LlmProvider[]) {
      if (this.config.providers[provider]) {
        this.activeKeys.set(provider, 0);
      }
    }
  }
```

Update `providerOrder` getter:

```typescript
  get providerOrder(): LlmProvider[] {
    const seen = new Set<LlmProvider>();
    const out: LlmProvider[] = [];
    for (const p of [...this.oauthOrder, ...this.keysOrder]) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out;
  }
```

Update `primaryProvider` to be the active tier's primary:

```typescript
  get primaryProvider(): LlmProvider {
    return this.oauthOrder[0] ?? this.config.primary;
  }
```

Replace cooldown-key construction throughout to use tier:

```typescript
  private cooldownKey(tier: AuthTier, provider: LlmProvider, keyIndex: number): string {
    return `${tier}:${provider}:${keyIndex}`;
  }
```

Replace every `${provider}:${i}` construction in this file with `this.cooldownKey(tier, provider, i)`.

Add the new `getActiveCredential()`:

```typescript
  /**
   * Walk OAuth tier first, then keys tier, returning the first credential not in cooldown.
   */
  getActiveCredential(): ActiveCredential | undefined {
    // OAuth tier
    for (const provider of this.oauthOrder) {
      const cred = this.oauthCredentials[provider];
      if (!cred) continue;
      if (this.isKeyUnavailable(this.cooldownKey('oauth', provider, 0))) continue;
      return { tier: 'oauth', provider, keyIndex: 0, label: cred.label };
    }
    // Keys tier
    for (const provider of this.keysOrder) {
      const providerConfig = this.config.providers[provider];
      if (!providerConfig) continue;
      for (let i = 0; i < providerConfig.keys.length; i++) {
        const key = providerConfig.keys[i];
        if (key.key && !this.isKeyUnavailable(this.cooldownKey('keys', provider, i))) {
          this.activeKeys.set(provider, i);
          return { tier: 'keys', provider, keyIndex: i, label: key.label };
        }
      }
    }
    return undefined;
  }
```

Update `getActiveKey(provider: LlmProvider)` to be tier-aware: it returns the active credential for the given provider in the *current* tier (OAuth if available, else keys). Add an optional `tier` parameter for callers that need to pin to one tier:

```typescript
  getActiveKey(provider: LlmProvider, tier?: AuthTier): ActiveCredential | undefined {
    const tryOAuth = () => {
      if (!this.oauthOrder.includes(provider)) return undefined;
      const cred = this.oauthCredentials[provider];
      if (!cred) return undefined;
      if (this.isKeyUnavailable(this.cooldownKey('oauth', provider, 0))) return undefined;
      return { tier: 'oauth' as const, provider, keyIndex: 0, label: cred.label };
    };
    const tryKeys = () => {
      const providerConfig = this.config.providers[provider];
      if (!providerConfig) return undefined;
      for (let i = 0; i < providerConfig.keys.length; i++) {
        const key = providerConfig.keys[i];
        if (key.key && !this.isKeyUnavailable(this.cooldownKey('keys', provider, i))) {
          this.activeKeys.set(provider, i);
          return { tier: 'keys' as const, provider, keyIndex: i, label: key.label };
        }
      }
      return undefined;
    };

    if (tier === 'oauth') return tryOAuth();
    if (tier === 'keys') return tryKeys();
    return tryOAuth() ?? tryKeys();
  }
```

Update `isKeyInCooldown` to accept a tier:

```typescript
  isKeyInCooldown(provider: LlmProvider, keyIndex: number, tier: AuthTier = 'keys'): boolean {
    return this.isKeyUnavailable(this.cooldownKey(tier, provider, keyIndex));
  }
```

Update `markKeyFailed` to accept a tier:

```typescript
  markKeyFailed(
    provider: LlmProvider,
    reason: 'auth' | 'rate_limit' | 'transient' = 'transient',
    errorMessage?: string,
    keyIndex?: number,
    tier: AuthTier = 'keys'
  ): boolean {
    const currentIndex = keyIndex ?? this.activeKeys.get(provider) ?? 0;
    const keyId = this.cooldownKey(tier, provider, currentIndex);

    if (!this.cooldowns.has(keyId)) {
      const now = Date.now();
      const duration =
        reason === 'rate_limit' ? this.cooldownConfig.rateLimitMs : this.cooldownConfig.defaultMs;
      this.cooldowns.set(keyId, { startTime: now, expiresAt: now + duration, reason });
      const detail = errorMessage ? `: ${errorMessage}` : '';
      log.info(`[AuthResolver] Key in cooldown: ${keyId}, expires in ${duration / 1000}s${detail}`);
    } else {
      log.info(`[AuthResolver] Key ${keyId} already in cooldown, skipping`);
    }

    // Walk forward through tiers/providers/keys to confirm something is still available
    return this.getActiveCredential() !== undefined;
  }
```

Update `getNextProvider`:

```typescript
  getNextProvider(): LlmProvider | undefined {
    return this.getActiveCredential()?.provider;
  }
```

Update `createAuthStorage()` to use the OAuth credential's access token when in OAuth tier for that provider:

```typescript
  createAuthStorage(): AuthStorage {
    const data: Record<string, { type: 'api_key'; key: string }> = {};

    // For each provider in either tier, choose the currently active credential.
    const providersInScope = new Set<LlmProvider>([...this.oauthOrder, ...this.keysOrder]);
    for (const provider of providersInScope) {
      const active = this.getActiveKey(provider);
      if (!active) continue;
      let keyValue: string | undefined;
      if (active.tier === 'oauth') {
        keyValue = this.oauthCredentials[provider]?.access;
      } else {
        keyValue = this.config.providers[provider]?.keys[active.keyIndex]?.key;
      }
      if (keyValue) {
        data[provider] = { type: 'api_key', key: keyValue };
      }
    }

    return AuthStorage.inMemory(data);
  }
```

Update `getStatus()` cooldown reporting to keep the new key format (no logical change beyond the key string being `tier:provider:idx`).

- [ ] **Step 4: Update existing tests for the new cooldown key format**

Existing tests in `auth-resolver.test.ts` that don't pass a tier default to `'keys'`. The cooldown key string changes from `anthropic:0` to `keys:anthropic:0`, but tests don't inspect the key string directly — they observe behavior via `getActiveKey`, `getNextProvider`, etc., which remain compatible. Run tests to confirm.

Run: `pnpm test src/server/agents/auth-resolver.test.ts`
Expected: PASS (existing tests + new two-tier tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/agents/auth-resolver.ts src/server/agents/auth-resolver.test.ts
git commit -m "feat(auth): two-tier credential model with OAuth-first failover"
```

---

## Task 6: AuthResolver `ensureFresh()` walks the OAuth tier

**Files:**
- Modify: `src/server/agents/auth-resolver.ts`
- Test: `src/server/agents/auth-resolver.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/server/agents/auth-resolver.test.ts`:

```typescript
import type { RefreshedTokens } from './oauth.js';

describe('AuthResolver.ensureFresh', () => {
  it('refreshes OAuth credential within expiry buffer and persists', async () => {
    const persisted: OAuthCredentials[] = [];
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'anthropic', fallback: [] },
    };
    const resolver = new AuthResolver(cfg, undefined, {
      anthropic: makeOAuthCreds(60_000), // 1 min — within buffer
    });
    resolver.setPersistOAuth('anthropic', async (creds) => {
      persisted.push(creds);
    });
    const refreshed = await resolver.ensureFresh({
      refresh: async (): Promise<RefreshedTokens> => ({
        access: 'new-access',
        refresh: 'rt-2',
        expires: Date.now() + 60 * 60_000,
      }),
    });
    expect(refreshed.has('anthropic')).toBe(true);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].refresh).toBe('rt-2');
  });

  it('does nothing when OAuth tier is empty', async () => {
    const cfg = makeTwoTierConfig();
    delete cfg.oauth;
    const resolver = new AuthResolver(cfg);
    const refreshed = await resolver.ensureFresh({
      refresh: async () => {
        throw new Error('should not be called');
      },
    });
    expect(refreshed.size).toBe(0);
  });

  it('does nothing when OAuth tokens are fresh', async () => {
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'anthropic', fallback: [] },
    };
    let calls = 0;
    const resolver = new AuthResolver(cfg, undefined, {
      anthropic: makeOAuthCreds(60 * 60_000), // 1 hour — fresh
    });
    await resolver.ensureFresh({
      refresh: async () => {
        calls++;
        return { access: 'x', refresh: 'y', expires: 1 };
      },
    });
    expect(calls).toBe(0);
  });

  it('serializes concurrent ensureFresh calls per provider', async () => {
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'anthropic', fallback: [] },
    };
    const resolver = new AuthResolver(cfg, undefined, { anthropic: makeOAuthCreds(1000) });
    let count = 0;
    const slow = async (): Promise<RefreshedTokens> => {
      count++;
      await new Promise((r) => setTimeout(r, 20));
      return { access: 'new', refresh: 'rt-2', expires: Date.now() + 60 * 60_000 };
    };
    await Promise.all([
      resolver.ensureFresh({ refresh: slow }),
      resolver.ensureFresh({ refresh: slow }),
      resolver.ensureFresh({ refresh: slow }),
    ]);
    expect(count).toBe(1);
  });

  it('throws when refresh fails', async () => {
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'anthropic', fallback: [] },
    };
    const resolver = new AuthResolver(cfg, undefined, { anthropic: makeOAuthCreds(1000) });
    await expect(
      resolver.ensureFresh({
        refresh: async () => {
          throw new Error('network down');
        },
      })
    ).rejects.toThrow('network down');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/server/agents/auth-resolver.test.ts -t "ensureFresh"`
Expected: FAIL

- [ ] **Step 3: Implement `ensureFresh` and `setPersistOAuth`**

In `src/server/agents/auth-resolver.ts`, add the import:

```typescript
import { isExpiringSoon, type RefreshedTokens } from './oauth.js';
```

Add fields to the class:

```typescript
  private persistCallbacks: Partial<Record<LlmProvider, (creds: OAuthCredentials) => Promise<void>>> = {};
  private refreshLocks: Map<LlmProvider, Promise<void>> = new Map();
```

Add methods:

```typescript
  setPersistOAuth(
    provider: LlmProvider,
    callback: (creds: OAuthCredentials) => Promise<void>
  ): void {
    this.persistCallbacks[provider] = callback;
  }

  /**
   * Refresh any OAuth credential whose access token is within the expiry buffer.
   * Returns the set of providers whose credentials were refreshed; callers should
   * reinitialize SDK sessions for those providers (existing sessions hold a snapshot
   * of the old access token).
   * Concurrent callers are serialized per provider so refresh runs once.
   */
  async ensureFresh(deps: {
    refresh: (refreshToken: string) => Promise<RefreshedTokens>;
  }): Promise<Set<LlmProvider>> {
    const refreshed = new Set<LlmProvider>();
    for (const provider of this.oauthOrder) {
      const cred = this.oauthCredentials[provider];
      if (!cred || !isExpiringSoon(cred.expires)) continue;

      const existing = this.refreshLocks.get(provider);
      if (existing) {
        await existing;
        const after = this.oauthCredentials[provider];
        if (after && !isExpiringSoon(after.expires)) {
          refreshed.add(provider);
          continue;
        }
      }

      const lock = this.doRefresh(provider, cred, deps.refresh).then(() => {
        this.refreshLocks.delete(provider);
      });
      this.refreshLocks.set(provider, lock);
      await lock;
      refreshed.add(provider);
    }
    return refreshed;
  }

  private async doRefresh(
    provider: LlmProvider,
    cred: OAuthCredentials,
    refresh: (refreshToken: string) => Promise<RefreshedTokens>
  ): Promise<void> {
    const tokens = await refresh(cred.refresh);
    const updated: OAuthCredentials = {
      access: tokens.access,
      refresh: tokens.refresh,
      expires: tokens.expires,
      label: cred.label,
    };
    this.oauthCredentials[provider] = updated;
    log.info(`[AuthResolver] OAuth token refreshed for ${provider}:${cred.label}`);

    const persist = this.persistCallbacks[provider];
    if (persist) {
      try {
        await persist(updated);
      } catch (err) {
        log.warn(`[AuthResolver] Failed to persist refreshed OAuth for ${provider}:`, err);
      }
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/server/agents/auth-resolver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/agents/auth-resolver.ts src/server/agents/auth-resolver.test.ts
git commit -m "feat(auth): ensureFresh() refreshes OAuth tier credentials with per-provider lock"
```

---

## Task 7: Wire OAuth loading into server startup

**Files:**
- Modify: `src/server/server.ts` (the file that constructs the shared AuthResolver)

- [ ] **Step 1: Locate AuthResolver construction**

Run: `grep -rn "new AuthResolver" src/server --include="*.ts" | grep -v test`
Note the file and line number.

- [ ] **Step 2: Add OAuth loading at startup**

In that file, near the top:

```typescript
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  loadOAuthCredentials,
  saveOAuthCredentials,
  type OAuthCredentials,
} from './agents/oauth-credentials.js';
import type { OAuthCredentialsMap } from './agents/auth-resolver.js';
import type { LlmProvider } from '../shared/index.js';

const SYSTEM2_DIR = join(homedir(), '.system2');
```

Replace the `new AuthResolver(config.llm)` call (skipping the existing null-check pattern, whatever it is) with:

```typescript
  const oauthCredentials: OAuthCredentialsMap = {};
  if (config.llm?.oauth) {
    const oauthProviders: LlmProvider[] = [
      config.llm.oauth.primary,
      ...config.llm.oauth.fallback,
    ];
    for (const provider of oauthProviders) {
      const creds = loadOAuthCredentials(SYSTEM2_DIR, provider);
      if (creds) {
        oauthCredentials[provider] = creds;
      } else {
        log.warn(
          `[server] [llm.oauth] declares ${provider} but ~/.system2/oauth/${provider}.json is missing — skipping`
        );
      }
    }
  }

  const authResolver = new AuthResolver(config.llm!, undefined, oauthCredentials);

  for (const provider of Object.keys(oauthCredentials) as LlmProvider[]) {
    authResolver.setPersistOAuth(provider, async (creds: OAuthCredentials) => {
      saveOAuthCredentials(SYSTEM2_DIR, provider, creds);
    });
  }
```

- [ ] **Step 3: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/server.ts
git commit -m "feat(server): load OAuth credentials at startup and wire persist callbacks"
```

---

## Task 8: AgentHost tracks tier and refreshes before session creation

**Files:**
- Modify: `src/server/agents/host.ts` (`initialize()` ~line 232; `reinitializeWithProvider()` ~line 844)
- Test: `src/server/agents/host.test.ts`

- [ ] **Step 1: Add `currentTier` field and call `ensureFresh`**

In `src/server/agents/host.ts`, add the import:

```typescript
import { refreshAnthropic } from './oauth.js';
import type { AuthTier } from './auth-resolver.js';
```

Add a field to the class:

```typescript
  private currentTier: AuthTier = 'keys';
```

In the constructor, set initial tier from active credential:

```typescript
    const activeCred = this.authResolver.getActiveCredential();
    this.currentProvider = activeCred?.provider ?? this.authResolver.primaryProvider;
    this.currentKeyIndex = activeCred?.keyIndex ?? 0;
    this.currentTier = activeCred?.tier ?? 'keys';
```

(replacing the existing `this.currentProvider = this.authResolver.primaryProvider;` line and the `currentKeyIndex` line on 223-224.)

In `initialize()`, just before `createAuthStorage()` (around line 472), insert:

```typescript
    // Refresh near-expiry OAuth tokens before snapshotting auth state into the SDK.
    try {
      await this.authResolver.ensureFresh({ refresh: refreshAnthropic });
    } catch (err) {
      log.warn('[AgentHost] OAuth refresh failed during initialize:', err);
      // Fall through with possibly-stale token; SDK will return 401 → handlePotentialError refreshes again.
    }
    // Re-read active credential in case ensureFresh changed which credential is active
    const cred = this.authResolver.getActiveCredential();
    if (cred) {
      this.currentTier = cred.tier;
      // currentProvider was already resolved above; only update tier and keyIndex
      this.currentKeyIndex = cred.keyIndex;
    }
```

In `reinitializeWithProvider()` (around line 844), insert the same `ensureFresh` block before line 883:

```typescript
    try {
      await this.authResolver.ensureFresh({ refresh: refreshAnthropic });
    } catch (err) {
      log.warn('[AgentHost] OAuth refresh failed during reinitialize:', err);
    }
```

After the line `this.currentKeyIndex = this.authResolver.getActiveKey(provider)?.keyIndex ?? 0;` (around line 874), add:

```typescript
    this.currentTier = this.authResolver.getActiveKey(provider)?.tier ?? 'keys';
```

- [ ] **Step 2: Update cooldown check to pass tier**

Around line 602 in `handlePotentialError()`:

```typescript
    if (this.authResolver.isKeyInCooldown(this.currentProvider, this.currentKeyIndex, this.currentTier)) {
```

Around line 710:

```typescript
      const hasMore = this.authResolver.markKeyFailed(
        this.currentProvider,
        category,
        errorMessage,
        this.currentKeyIndex,
        this.currentTier
      );
```

- [ ] **Step 3: Add a smoke test**

Append to `src/server/agents/host.test.ts` a minimal regression test confirming `currentTier` reflects the active credential. Use the existing test fixtures for AgentHost; if no harness exists, fall back to a simpler test that constructs an AuthResolver with OAuth credentials and asserts `host.currentTier === 'oauth'` after `initialize()`.

(Since `currentTier` is private, expose a `getCurrentTier()` test helper or — preferred — assert the behavior via cooldown key inspection: after a simulated auth failure, `getStatus()` reports `oauth:anthropic:0` in cooldowns iff the host was on the OAuth tier.)

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/agents/host.ts src/server/agents/host.test.ts
git commit -m "feat(host): track auth tier and refresh OAuth before session creation"
```

---

## Task 9: AgentHost refresh-and-retry on 401 from OAuth tier

**Files:**
- Modify: `src/server/agents/host.ts` (`handlePotentialError()` around line 558)
- Test: `src/server/agents/host.test.ts`

- [ ] **Step 1: Add the refresh-and-retry branch**

In `handlePotentialError()`, after `category` is computed (line 580) and *before* the cooldown check on line 602, insert:

```typescript
    // OAuth refresh-and-retry: 401 from an OAuth-tier credential should refresh once
    // before failing over. Refresh updates in-memory tokens; reinitialize the session
    // so the SDK picks up the new access token.
    if (category === 'auth' && this.currentTier === 'oauth' && !this.oauthRefreshAttempted) {
      this.oauthRefreshAttempted = true;
      try {
        await this.authResolver.ensureFresh({ refresh: refreshAnthropic });
        log.info('[AgentHost] OAuth token refreshed after 401, retrying via reinitialize');
        await this.reinitializeWithProvider(
          this.currentProvider,
          promptToRetry,
          deliveriesToRetry,
          'OAuth token refreshed',
          `401 on ${this.currentProvider} OAuth credential, refreshed and retrying`
        );
        return;
      } catch (refreshErr) {
        log.warn('[AgentHost] OAuth refresh failed after 401, falling over:', refreshErr);
        // Fall through to standard auth-failure handling below
      }
    }
```

Add the field at the top of the class:

```typescript
  private oauthRefreshAttempted = false;
```

Reset it on successful turn — in `handleSessionEvent()`'s `agent_end` branch, inside the existing `if (!this.lastTurnErrored) { ... }` block:

```typescript
        this.oauthRefreshAttempted = false;
```

- [ ] **Step 2: Add tests**

Append to `src/server/agents/host.test.ts`. Use a stubbed AuthResolver that exposes a controllable `ensureFresh` and a mock session that emits a `message_end` with `stopReason: 'error'` and a 401-shaped errorMessage. Two cases:
1. `ensureFresh` succeeds → `reinitializeWithProvider` is called, `markKeyFailed` is **not** called.
2. `ensureFresh` throws → falls through to standard failover (`markKeyFailed` is called).

(If the existing host.test.ts harness already covers the `handlePotentialError` path, mirror that style; otherwise a small targeted unit test exercising `handlePotentialError` directly is acceptable.)

- [ ] **Step 3: Run tests**

Run: `pnpm test src/server/agents/host.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/agents/host.ts src/server/agents/host.test.ts
git commit -m "feat(host): refresh OAuth and retry once on 401 before failover"
```

---

## Task 10: Onboarding — two-step flow

**Files:**
- Modify: `src/cli/commands/onboard.ts`

- [ ] **Step 1: Add imports**

At the top of `src/cli/commands/onboard.ts`:

```typescript
import { mkdir as mkdirAsync } from 'node:fs/promises';
import { loginAnthropic } from '../../server/agents/oauth.js';
import { saveOAuthCredentials } from '../../server/agents/oauth-credentials.js';
```

- [ ] **Step 2: Define OAuth provider catalog**

Add near the top, alongside `PROVIDERS`:

```typescript
const OAUTH_PROVIDERS: { value: LlmProvider; label: string; hint: string }[] = [
  {
    value: 'anthropic',
    label: 'Anthropic (Claude Pro/Max)',
    hint: 'Uses your Claude.ai subscription. No API key needed.',
  },
];
```

(Future: add Google Gemini CLI, GitHub Copilot, OpenAI Codex.)

- [ ] **Step 3: Implement OAuth login helper**

```typescript
async function runOAuthLogin(provider: LlmProvider): Promise<{ label: string } | null> {
  if (provider !== 'anthropic') {
    p.log.error(`OAuth login for ${provider} is not implemented yet`);
    return null;
  }

  const label = (await p.text({
    message: 'Label for this OAuth credential:',
    placeholder: 'claude-pro',
    defaultValue: 'claude-pro',
  })) as string;

  if (p.isCancel(label)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }

  if (!existsSync(SYSTEM2_DIR)) {
    await mkdirAsync(SYSTEM2_DIR, { recursive: true });
  }

  const s = p.spinner();
  s.start('Waiting for browser authentication...');
  try {
    const creds = await loginAnthropic({
      onAuth: ({ url }) => {
        s.message(`Open this URL to authenticate:\n${url}`);
      },
      onPrompt: async ({ message, placeholder }) => {
        s.stop('Browser callback timed out');
        const value = (await p.text({ message, placeholder })) as string;
        if (p.isCancel(value)) {
          p.cancel('Onboarding cancelled');
          process.exit(0);
        }
        s.start('Exchanging code...');
        return value;
      },
      onProgress: (m) => s.message(m),
    });
    saveOAuthCredentials(SYSTEM2_DIR, provider, {
      access: creds.access,
      refresh: creds.refresh,
      expires: creds.expires,
      label: label || 'claude-pro',
    });
    s.stop('✓ OAuth login successful');
    return { label: label || 'claude-pro' };
  } catch (err) {
    s.stop('✗ OAuth login failed');
    p.log.error(err instanceof Error ? err.message : String(err));
    return null;
  }
}
```

- [ ] **Step 4: Implement OAuth tier collection**

```typescript
async function collectOAuthTier(): Promise<LlmOAuthConfig | null> {
  const wantsOAuth = await p.confirm({
    message: 'Configure OAuth providers? (recommended if you have a Claude Pro/Max subscription)',
    initialValue: true,
  });
  if (p.isCancel(wantsOAuth)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }
  if (!wantsOAuth) return null;

  const primary = (await p.select({
    message: 'Select your primary OAuth provider:',
    options: OAUTH_PROVIDERS,
  })) as LlmProvider;
  if (p.isCancel(primary)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }

  const result = await runOAuthLogin(primary);
  if (!result) {
    const retry = await p.confirm({
      message: 'OAuth login failed. Skip OAuth tier and continue with API keys only?',
      initialValue: true,
    });
    if (p.isCancel(retry) || !retry) {
      p.cancel('Onboarding cancelled');
      process.exit(0);
    }
    return null;
  }

  const fallback: LlmProvider[] = [];
  let availableOAuth = OAUTH_PROVIDERS.filter((o) => o.value !== primary);
  while (availableOAuth.length > 0) {
    const addMore = await p.confirm({
      message: 'Add another OAuth provider as fallback?',
      initialValue: false,
    });
    if (p.isCancel(addMore)) {
      p.cancel('Onboarding cancelled');
      process.exit(0);
    }
    if (!addMore) break;

    const next = (await p.select({
      message: 'Select fallback OAuth provider:',
      options: availableOAuth,
    })) as LlmProvider;
    if (p.isCancel(next)) {
      p.cancel('Onboarding cancelled');
      process.exit(0);
    }
    const r = await runOAuthLogin(next);
    if (r) {
      fallback.push(next);
    }
    availableOAuth = availableOAuth.filter((o) => o.value !== next);
  }

  return { primary, fallback };
}
```

Add the import at the top:

```typescript
import type { LlmOAuthConfig } from '../../shared/index.js';
```

- [ ] **Step 5: Wrap API-key tier collection so it can be skipped**

Refactor the existing API-key collection (the chunk currently between the intro and the LlmConfig assembly, roughly lines 252-345) into a helper:

```typescript
async function collectApiKeyTier(): Promise<{
  llm: { primary: LlmProvider; fallback: LlmProvider[]; providers: Partial<Record<LlmProvider, LlmProviderConfig>> } | null;
  services?: ServicesConfig;
  tools?: ToolsConfig;
}> {
  // Body lifted from existing onboard() — keeps the same prompts, returns the assembled
  // primary/fallback/providers/services/tools tuple. Returns { llm: null } if user opts out.
}
```

(The exact body is the existing onboarding code, unchanged. Take care to preserve the `openai-compatible` extras path.)

Add at the start of that helper:

```typescript
  const wantsApiKeys = await p.confirm({
    message: 'Configure API key providers? (recommended as fallback when OAuth rate-limits)',
    initialValue: true,
  });
  if (p.isCancel(wantsApiKeys)) {
    p.cancel('Onboarding cancelled');
    process.exit(0);
  }
  if (!wantsApiKeys) {
    return { llm: null };
  }
```

- [ ] **Step 6: Compose the two tiers in `onboard()`**

The body of `onboard()` becomes:

```typescript
    const oauthTier = await collectOAuthTier();
    const apiKeyTier = await collectApiKeyTier();

    if (!oauthTier && !apiKeyTier.llm) {
      p.log.error('At least one auth tier (OAuth or API keys) must be configured.');
      // Loop or exit — for v1, exit and ask user to re-run onboard.
      p.cancel('Onboarding cancelled');
      process.exit(1);
    }

    const llmConfig: LlmConfig = apiKeyTier.llm
      ? { ...apiKeyTier.llm }
      : {
          primary: oauthTier!.primary, // safe: at least one tier configured
          fallback: [],
          providers: {},
        };
    if (oauthTier) {
      llmConfig.oauth = oauthTier;
    }

    const { services, tools } = await collectWebSearchConfig();

    // ... existing bootstrap call ...
```

(If `apiKeyTier.llm` is null but OAuth is configured, set `llmConfig.primary` to the OAuth primary and leave `providers` empty. Add the matching empty `providers[oauthTier.primary] = { keys: [] }` so later code that iterates providers doesn't fail; verify by running the daemon in this state.)

- [ ] **Step 7: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 8: Manual smoke test**

Run: `pnpm build && node dist/cli/index.js onboard`
Expected: First prompt is "Configure OAuth providers?". Selecting yes then anthropic opens browser. After login, second pass asks about API keys. Both can be configured independently. Final state: `~/.system2/oauth/anthropic.json` (mode 0600), `~/.system2/config.toml` with `[llm.oauth]` section.

- [ ] **Step 9: Commit**

```bash
git add src/cli/commands/onboard.ts
git commit -m "feat(onboard): two-step flow for OAuth tier then API key tier"
```

---

## Task 11: Documentation

**Files:**
- Modify: `docs/configuration.md`, `docs/agents.md`

- [ ] **Step 1: Update `docs/configuration.md`**

Add to the config example near the top (around line 15):

````markdown
# OAuth tier — subscription credentials, tried first
[llm.oauth]
primary = "anthropic"
fallback = []   # only anthropic OAuth supported in v1

# API key tier — billed per token, used after OAuth tier exhausted
[llm]
primary = "anthropic"
fallback = ["google", "openai"]
````

Add a new section after "Automatic Failover" (around line 162):

````markdown
## Auth Tiers

System2 has two auth tiers:

- **OAuth tier** — subscription credentials (`[llm.oauth]`). Tried first. v1 supports Anthropic Claude Pro/Max OAuth. Pi-ai supports Google Gemini CLI, GitHub Copilot, and OpenAI Codex OAuth as well; those will be added in future iterations.
- **API key tier** — `[llm].primary` + `fallback`. Same shape as today. Used after the OAuth tier is fully exhausted (every OAuth credential in cooldown).

The OAuth tier is fully exhausted before the system drops into the API key tier — never interleaving. If `[llm.oauth]` is absent, system2 behaves exactly like an API-key-only setup.

### Anthropic OAuth (Claude Pro/Max)

The pi-ai SDK detects OAuth tokens (substring match `sk-ant-oat`) and switches the Anthropic client to Bearer auth + Claude Code identity headers. The agent loop, custom tools, and multi-agent orchestration are unchanged.

**Setup:** During `system2 onboard`, the first step asks whether to configure OAuth. Selecting "yes" + "Anthropic" opens a browser for Claude.ai authentication. The resulting tokens are saved to `~/.system2/oauth/anthropic.json` (mode 0600).

**Refresh:** OAuth access tokens expire roughly hourly. The daemon refreshes them automatically before each agent session creation and on 401 errors. Refreshed tokens are persisted back to `~/.system2/oauth/anthropic.json`.

**Failover:** A 401 on an OAuth credential triggers one refresh-and-retry. If refresh succeeds, the session reinitializes with the new token and the prompt retries. If refresh fails (or any other error), the OAuth credential enters cooldown and the next OAuth fallback is tried; once the OAuth tier is exhausted, the system drops into the API key tier.

**Caveats:**
- Claude Pro/Max usage limits are sized for one human in Claude Code. A multi-agent system2 workload (Guide + Conductor + Reviewer + Workers + Narrator running concurrently) can hit the 5-hour message cap quickly. Configure the API key tier as fallback for sustained workloads.
- Programmatic use of Pro/Max credentials outside Claude Code is in a TOS gray area. Use at your own discretion.
- Prompt caching is disabled on the OAuth path (the SDK strips `cache_control` from system prompts for OAuth tokens). Per-call billing still goes through the subscription.
````

- [ ] **Step 2: Update `docs/agents.md`**

In the `AuthResolver` section (around line 138-160), append:

````markdown
### Two-Tier Credentials (OAuth + API Keys)

When `[llm.oauth]` is configured, `AuthResolver` walks credentials across two tiers:

1. **OAuth tier** — providers listed in `[llm.oauth].primary` + `fallback`, each with one credential loaded from `~/.system2/oauth/<provider>.json` at startup.
2. **API key tier** — providers listed in `[llm].primary` + `fallback`, with one or more API keys each.

`getActiveCredential()` returns a `{ tier, provider, keyIndex, label }` tuple. Cooldown keys are namespaced as `${tier}:${provider}:${keyIndex}` so the same provider in both tiers (e.g., Anthropic OAuth and Anthropic API keys) doesn't collide. The OAuth tier is fully exhausted (every credential in cooldown) before the resolver returns a keys-tier credential.

Two extra concerns over plain API keys:

1. **Refresh.** `AuthResolver.ensureFresh()` is awaited before each session creation in `AgentHost.initialize()` and `reinitializeWithProvider()`. If an OAuth access token is within 5 minutes of expiry, the resolver calls the SDK's `refreshAnthropicToken`, updates in-memory state, and persists via the callback registered through `setPersistOAuth()`. Concurrent refreshes per provider are serialized via a Promise lock.
2. **401 handling.** Normally `auth` errors trigger immediate failover. For OAuth-tier credentials, `AgentHost` first calls `ensureFresh()` and reinitializes the session before falling over — this catches expiry-related 401s without losing the credential. If refresh itself fails, the credential goes into cooldown via the standard path.
````

- [ ] **Step 3: Run docs check**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add docs/configuration.md docs/agents.md
git commit -m "docs: document two-tier auth and Claude Pro/Max OAuth"
```

---

## Task 12: End-to-end integration test

**Files:**
- Create: `src/server/agents/oauth-flow.test.ts`

- [ ] **Step 1: Write the test**

Create `src/server/agents/oauth-flow.test.ts`:

```typescript
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
    oauth: { primary: 'anthropic', fallback: [] },
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
    expect(loaded).not.toBeNull();

    const resolver = new AuthResolver(makeTwoTierConfig(), undefined, {
      anthropic: loaded!,
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
    const resolver = new AuthResolver(makeTwoTierConfig(), undefined, {
      anthropic: loadOAuthCredentials(tmpDir, 'anthropic')!,
    });

    expect(resolver.getActiveCredential()?.tier).toBe('oauth');

    resolver.markKeyFailed('anthropic', 'auth', 'invalid_grant', 0, 'oauth');

    const active = resolver.getActiveCredential();
    expect(active?.tier).toBe('keys');
    expect(active?.provider).toBe('anthropic');
    expect(active?.label).toBe('api-fallback');
  });

  it('cycles through entire OAuth tier before dropping to keys tier', async () => {
    const cfg: LlmConfig = {
      ...makeTwoTierConfig(),
      oauth: { primary: 'anthropic', fallback: ['openai'] },
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
    const resolver = new AuthResolver(cfg, undefined, {
      anthropic: loadOAuthCredentials(tmpDir, 'anthropic')!,
      openai: loadOAuthCredentials(tmpDir, 'openai')!,
    });

    expect(resolver.getActiveCredential()).toMatchObject({
      tier: 'oauth',
      provider: 'anthropic',
    });

    resolver.markKeyFailed('anthropic', 'auth', 'fail', 0, 'oauth');
    expect(resolver.getActiveCredential()).toMatchObject({ tier: 'oauth', provider: 'openai' });

    resolver.markKeyFailed('openai', 'auth', 'fail', 0, 'oauth');
    expect(resolver.getActiveCredential()).toMatchObject({ tier: 'keys', provider: 'anthropic' });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test src/server/agents/oauth-flow.test.ts`
Expected: PASS

- [ ] **Step 3: Run full check**

Run: `pnpm check && pnpm typecheck && pnpm build && pnpm test`
Expected: PASS across the board

- [ ] **Step 4: Commit**

```bash
git add src/server/agents/oauth-flow.test.ts
git commit -m "test: end-to-end two-tier OAuth flow"
```

---

## Self-review notes

- **Spec coverage:** Two-tier model with OAuth-first failover (Tasks 1, 2, 5, 6, 12), OAuth opt-in via onboarding asked first (Task 10), at least one tier required (Task 10), API key tier behaves identically when OAuth absent (Tasks 5, 7), refresh-and-retry on 401 (Task 9), token persistence (Tasks 3, 6, 7).
- **Type consistency:** `OAuthCredentials` defined in Task 3, used in Tasks 5, 6, 7, 12. `RefreshedTokens` defined in Task 4, used in Task 6. `ActiveCredential`, `AuthTier`, `OAuthCredentialsMap` defined in Task 5, used in Tasks 7, 8, 12. `LlmOAuthConfig` defined in Task 1, used in Tasks 2, 10.
- **Backwards compatibility:** `[llm.oauth]` is optional. Existing configs without `[llm.oauth]` keep the today's behavior (single keys tier). Cooldown key format changes from `provider:idx` to `tier:provider:idx`, but no consumer parses these strings — they're internal map keys.
- **Concurrency:** Per-provider refresh lock (Task 6) prevents thundering-herd refresh from multiple agents.
- **Failure modes covered:** corrupt credentials file (Task 3), refresh network failure (Tasks 6, 9), revoked OAuth grant (Tasks 9, 12), missing credentials file when `[llm.oauth]` declares a provider (Task 7), OAuth tier exhaustion → keys tier transition (Task 12).

## Things deliberately out of scope

- A `system2 login <provider>` standalone re-auth command. Users can re-run onboarding (after backing up `~/.system2`) or manually delete the credentials file and edit config.toml.
- UI surfacing of OAuth state in `/api/agents`. Logging via the existing chat-message error path is sufficient for v1.
- Multi-account OAuth (more than one credential per provider). v1 supports one credential per provider.
- Per-role override of which tier to use. The user explicitly does not want this — both tiers apply globally to every agent.
- Google Gemini CLI, GitHub Copilot, OpenAI Codex OAuth. The architecture supports them (provider-parameterized credentials file, OAuth-tier orderings), but each needs its own pi-ai integration plumbing. Filed as a follow-up.
