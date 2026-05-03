/**
 * TOML patchers for `~/.system2/auth/auth.toml`.
 *
 * Each patcher is a thin wrapper around `withAuth(authPath, mutate)`: read the
 * file, parse it, mutate the in-memory object, stringify, and write atomically.
 * No regex, no comment preservation, no boundary detection — all the bug
 * classes that plagued the 0.2.x regex implementation (stub replacement, EOF
 * placement, sub-section repair, control-char escaping) are gone because
 * `@iarna/toml` round-trips structured data losslessly.
 *
 * Comments are not preserved across writes; this is by design. `auth.toml` is
 * machine-managed (`system2 config` writes it, never the user). The header
 * line `# Managed by 'system2 config' — do not edit by hand.` is re-emitted
 * on every write so the warning persists.
 *
 * Function signatures keep `{ changed: boolean }` returns where they did in
 * 0.2.x so call-sites in src/cli/commands/config.ts don't churn beyond the
 * `configPath → authPath` rename.
 */

import type { LlmKey, LlmProvider } from '../../shared/index.js';
import { type AuthToml, loadAuthToml, withAuth } from './auth-config.js';

// ─── OAuth tier ───────────────────────────────────────────────────────────────

/**
 * Read the current `[llm.oauth]` tier. Returns null when the section is
 * absent or has no primary set (matching 0.2.x semantics — both states
 * meant "OAuth tier not usable").
 */
export function readOAuthTier(authPath: string): { primary: string; fallback: string[] } | null {
  let result: { primary: string; fallback: string[] } | null = null;
  withAuthRead(authPath, (auth) => {
    const oauth = auth.llm?.oauth;
    if (!oauth?.primary) return;
    result = { primary: oauth.primary, fallback: oauth.fallback ?? [] };
  });
  return result;
}

/**
 * Add `provider` to the OAuth tier.
 * - Empty tier: create with `provider` as primary.
 * - Existing tier: append to fallback (no-op if already in tier).
 */
export function addProviderToOAuthTier(
  authPath: string,
  provider: LlmProvider
): { changed: boolean } {
  let changed = false;
  withAuth(authPath, (auth) => {
    if (!auth.llm) auth.llm = {};
    if (!auth.llm.oauth) {
      auth.llm.oauth = { primary: provider, fallback: [] };
      changed = true;
      return;
    }
    if (!auth.llm.oauth.primary) {
      auth.llm.oauth.primary = provider;
      auth.llm.oauth.fallback = auth.llm.oauth.fallback ?? [];
      changed = true;
      return;
    }
    if (auth.llm.oauth.primary === provider) return;
    const fallback = (auth.llm.oauth.fallback ?? []) as string[];
    if (fallback.includes(provider)) return;
    auth.llm.oauth.fallback = [...fallback, provider];
    changed = true;
  });
  return { changed };
}

/**
 * Remove `provider` from the OAuth tier.
 * - Removes from primary (promoting first fallback if any) or fallback array.
 * - Drops the [llm.oauth] section entirely when no providers remain.
 */
export function removeProviderFromOAuthTier(
  authPath: string,
  provider: LlmProvider
): { changed: boolean } {
  let changed = false;
  withAuth(authPath, (auth) => {
    const oauth = auth.llm?.oauth;
    if (!oauth) return;

    const isPrimary = oauth.primary === provider;
    const fallbackArr = (oauth.fallback ?? []) as string[];
    const inFallback = fallbackArr.includes(provider);
    if (!isPrimary && !inFallback) return;

    if (isPrimary) {
      const remaining = fallbackArr.filter((p) => p !== provider);
      if (remaining.length === 0) {
        delete auth.llm?.oauth;
      } else {
        oauth.primary = remaining[0];
        oauth.fallback = remaining.slice(1);
      }
    } else {
      oauth.fallback = fallbackArr.filter((p) => p !== provider);
    }

    // Drop any leftover per-provider OAuth pin (e.g. [llm.oauth.<provider>]).
    if (auth.llm?.oauth && provider in auth.llm.oauth) {
      delete (auth.llm.oauth as Record<string, unknown>)[provider];
    }

    changed = true;
  });
  return { changed };
}

/**
 * Replace the OAuth fallback list verbatim. Order matters — index 0 is the
 * second-tried provider, after `primary`. Rejects a fallback list that
 * contains the current primary (would create an unusable duplicate-tier
 * state); use `setProviderAsPrimary` first if the intent is a swap.
 */
export function setOAuthFallbackOrder(authPath: string, fallback: LlmProvider[]): void {
  withAuth(authPath, (auth) => {
    if (!auth.llm?.oauth?.primary) {
      throw new Error('Cannot reorder OAuth fallbacks: [llm.oauth] is not configured');
    }
    const primary = auth.llm.oauth.primary;
    if (fallback.some((p) => p === primary)) {
      throw new Error(`primary cannot appear in fallback: ${primary}`);
    }
    auth.llm.oauth.fallback = [...fallback];
  });
}

/**
 * Promote `provider` to OAuth primary, demoting the existing primary to
 * fallback[0]. No-op when `provider` is already primary.
 */
export function setProviderAsPrimary(
  authPath: string,
  provider: LlmProvider
): { changed: boolean } {
  let changed = false;
  withAuth(authPath, (auth) => {
    const oauth = auth.llm?.oauth;
    if (!oauth?.primary) {
      throw new Error('Cannot set OAuth primary: [llm.oauth] is not configured');
    }
    if (oauth.primary === provider) return;
    const oldPrimary = oauth.primary;
    const fallbackArr = (oauth.fallback ?? []) as string[];
    const newFallback = [oldPrimary, ...fallbackArr.filter((p) => p !== provider)];
    oauth.primary = provider;
    oauth.fallback = newFallback;
    changed = true;
  });
  return { changed };
}

// ─── API keys tier ────────────────────────────────────────────────────────────

/**
 * Read the current `[llm.api_keys]` tier. Returns null when the section is
 * absent or lacks a primary. The `providers` set lists all keys other than
 * `primary` and `fallback` — i.e. each `[llm.api_keys.<provider>]` sub-table
 * present.
 */
export function readApiKeysTier(
  authPath: string
): { primary: string; fallback: string[]; providers: Set<string> } | null {
  let result: { primary: string; fallback: string[]; providers: Set<string> } | null = null;
  withAuthRead(authPath, (auth) => {
    const tier = auth.llm?.api_keys;
    if (!tier?.primary) return;
    const providers = new Set<string>();
    for (const k of Object.keys(tier)) {
      if (k !== 'primary' && k !== 'fallback') providers.add(k);
    }
    result = { primary: tier.primary, fallback: (tier.fallback ?? []) as string[], providers };
  });
  return result;
}

/**
 * Optional extras for openai-compatible. Other providers ignore them.
 */
export interface ApiKeyProviderExtras {
  base_url?: string;
  model?: string;
  compat_reasoning?: boolean;
}

/**
 * Add a new API-key provider with its initial keys.
 * - Empty tier: create with `provider` as primary, no fallback.
 * - Existing tier with `provider` already in primary/fallback AND a sub-table
 *   already present: throw (use addKeyToApiKeyProvider to add more keys).
 * - Existing tier with `provider` in primary/fallback but no sub-table:
 *   write the sub-table without touching tier order (repair case for
 *   half-edited installs).
 * - Otherwise: append to fallback and write the sub-table.
 */
export function addProviderToApiKeysTier(
  authPath: string,
  provider: LlmProvider,
  keys: LlmKey[],
  extras?: ApiKeyProviderExtras
): { changed: boolean } {
  validateKeysArray(provider, keys);

  let changed = false;
  withAuth(authPath, (auth) => {
    if (!auth.llm) auth.llm = {};
    if (!auth.llm.api_keys) {
      auth.llm.api_keys = { primary: provider, fallback: [] };
    } else if (!auth.llm.api_keys.primary) {
      auth.llm.api_keys.primary = provider;
      auth.llm.api_keys.fallback = (auth.llm.api_keys.fallback ?? []) as string[];
    }

    const tier = auth.llm.api_keys;
    const inTierList =
      tier.primary === provider || ((tier.fallback ?? []) as string[]).includes(provider);
    // `provider` is typed as LlmProvider, which is disjoint from 'primary' /
    // 'fallback' — `provider in tier` is sufficient.
    const hasSubTable = provider in tier;

    if (inTierList && hasSubTable) {
      throw new Error(`${provider} already in [llm.api_keys]`);
    }

    if (!inTierList) {
      tier.fallback = [...((tier.fallback ?? []) as string[]), provider];
    }

    const subTable: Record<string, unknown> = { keys: keys.map((k) => ({ ...k })) };
    if (extras?.base_url !== undefined) subTable.base_url = extras.base_url;
    if (extras?.model !== undefined) subTable.model = extras.model;
    if (extras?.compat_reasoning !== undefined) {
      subTable.compat_reasoning = extras.compat_reasoning;
    }
    (tier as Record<string, unknown>)[provider] = subTable;

    changed = true;
  });
  return { changed };
}

/**
 * Remove `provider` from the API-keys tier entirely (sub-table + tier list).
 * Drops [llm.api_keys] when the last provider is removed.
 */
export function removeProviderFromApiKeysTier(
  authPath: string,
  provider: LlmProvider
): { changed: boolean } {
  let changed = false;
  withAuth(authPath, (auth) => {
    const tier = auth.llm?.api_keys;
    if (!tier) return;

    const isPrimary = tier.primary === provider;
    const fallbackArr = (tier.fallback ?? []) as string[];
    const inFallback = fallbackArr.includes(provider);
    // `provider` is typed as LlmProvider, which is disjoint from 'primary' /
    // 'fallback' — `provider in tier` is sufficient.
    const hasSubTable = provider in tier;
    if (!isPrimary && !inFallback && !hasSubTable) return;

    if (hasSubTable) {
      delete (tier as Record<string, unknown>)[provider];
    }

    if (isPrimary) {
      const remaining = fallbackArr.filter((p) => p !== provider);
      if (remaining.length === 0) {
        // No other providers in the tier — drop it entirely.
        delete auth.llm?.api_keys;
      } else {
        tier.primary = remaining[0];
        tier.fallback = remaining.slice(1);
      }
    } else {
      tier.fallback = fallbackArr.filter((p) => p !== provider);
    }

    changed = true;
  });
  return { changed };
}

/**
 * Promote `provider` to API-keys primary, demoting the existing primary to
 * fallback[0]. No-op when already primary. Throws when provider has no
 * sub-table (would create an unusable tier list pointing at nothing).
 */
export function setApiKeyProviderAsPrimary(
  authPath: string,
  provider: LlmProvider
): { changed: boolean } {
  let changed = false;
  withAuth(authPath, (auth) => {
    const tier = auth.llm?.api_keys;
    if (!tier?.primary) {
      throw new Error('Cannot set API-keys primary: [llm.api_keys] is not configured');
    }
    if (!(provider in tier)) {
      throw new Error(`Cannot promote ${provider}: no [llm.api_keys.${provider}] sub-table`);
    }
    if (tier.primary === provider) return;
    const oldPrimary = tier.primary;
    const fallbackArr = (tier.fallback ?? []) as string[];
    tier.primary = provider;
    tier.fallback = [oldPrimary, ...fallbackArr.filter((p) => p !== provider)];
    changed = true;
  });
  return { changed };
}

/**
 * Replace the API-keys fallback list verbatim. Rejects a fallback list that
 * contains the current primary; use `setApiKeyProviderAsPrimary` first if the
 * intent is a swap.
 */
export function setApiKeysFallbackOrder(authPath: string, fallback: LlmProvider[]): void {
  withAuth(authPath, (auth) => {
    if (!auth.llm?.api_keys?.primary) {
      throw new Error('Cannot reorder API-keys fallbacks: [llm.api_keys] is not configured');
    }
    const primary = auth.llm.api_keys.primary;
    if (fallback.some((p) => p === primary)) {
      throw new Error(`primary cannot appear in fallback: ${primary}`);
    }
    auth.llm.api_keys.fallback = [...fallback];
  });
}

/**
 * Append a key to an existing provider's `keys` array. Throws on duplicate
 * label (later operations address keys by label).
 */
export function addKeyToApiKeyProvider(authPath: string, provider: LlmProvider, key: LlmKey): void {
  if (!key.key) throw new Error(`addKeyToApiKeyProvider: empty key value for ${provider}`);
  if (!key.label) throw new Error(`addKeyToApiKeyProvider: empty label for ${provider}`);

  withAuth(authPath, (auth) => {
    const tier = auth.llm?.api_keys;
    const sub = tier?.[provider] as { keys?: LlmKey[] } | undefined;
    if (!sub) {
      throw new Error(`Cannot add key: [llm.api_keys.${provider}] is not configured`);
    }
    const keys = sub.keys ?? [];
    if (keys.some((k) => k.label === key.label)) {
      throw new Error(`Label "${key.label}" already exists for ${provider}`);
    }
    sub.keys = [...keys, { key: key.key, label: key.label }];
  });
}

/**
 * Remove a single key from a provider by label. When `label` is undefined,
 * remove all keys for the provider. Removes the provider entirely (tier list
 * + sub-table) when its last key is removed, to keep the runtime from
 * tripping on a key-less provider.
 */
export function removeKeyFromApiKeyProvider(
  authPath: string,
  provider: LlmProvider,
  label?: string
): { changed: boolean } {
  let changed = false;
  let providerLeftEmpty = false;

  withAuth(authPath, (auth) => {
    const tier = auth.llm?.api_keys;
    const sub = tier?.[provider] as { keys?: LlmKey[] } | undefined;
    if (!sub?.keys || sub.keys.length === 0) return;

    if (label === undefined) {
      sub.keys = [];
    } else {
      const before = sub.keys.length;
      sub.keys = sub.keys.filter((k) => k.label !== label);
      if (sub.keys.length === before) return;
    }

    if (sub.keys.length === 0) providerLeftEmpty = true;
    changed = true;
  });

  // If the provider is now key-less, remove it entirely (separate withAuth
  // pass keeps the in-flight mutation simple and the empty-keys handling
  // local to one branch).
  if (providerLeftEmpty) {
    removeProviderFromApiKeysTier(authPath, provider);
  }

  return { changed };
}

/**
 * Replace the value of an existing labeled key in place. Preserves order
 * and the provider's primary/fallback position (no remove-then-add dance
 * that could shuffle the tier).
 */
export function replaceKeyInApiKeyProvider(
  authPath: string,
  provider: LlmProvider,
  label: string,
  newKey: string
): void {
  if (!newKey) throw new Error(`replaceKeyInApiKeyProvider: empty new key for ${provider}`);
  withAuth(authPath, (auth) => {
    const tier = auth.llm?.api_keys;
    const sub = tier?.[provider] as { keys?: LlmKey[] } | undefined;
    if (!sub?.keys) {
      throw new Error(`Cannot replace key: [llm.api_keys.${provider}] is not configured`);
    }
    const idx = sub.keys.findIndex((k) => k.label === label);
    if (idx === -1) {
      throw new Error(`Cannot replace key: no key labeled "${label}" for ${provider}`);
    }
    sub.keys[idx] = { key: newKey, label };
  });
}

// ─── Brave Search + web_search ────────────────────────────────────────────────

/**
 * Set the Brave Search API key and enable the web_search tool.
 *
 * In 0.3.0, `[tools.web_search].enabled` lives in auth.toml (it's
 * system-managed: enabled when Brave key is added, disabled when removed).
 * `[tools.web_search].max_results` lives separately in config.toml as the
 * top-level `web_search_max_results` scalar (operational tunable).
 */
export function setBraveSearchKey(authPath: string, apiKey: string): { changed: boolean } {
  if (!apiKey) throw new Error('setBraveSearchKey: empty api key');
  let changed = false;
  withAuth(authPath, (auth) => {
    if (!auth.services) auth.services = {};
    const before = auth.services.brave_search?.key;
    auth.services.brave_search = { key: apiKey };
    if (!auth.tools) auth.tools = {};
    auth.tools.web_search = { enabled: true };
    changed = before !== apiKey;
  });
  return { changed };
}

/**
 * Remove Brave Search and disable the web_search tool. Drops both
 * [services.brave_search] and [tools.web_search] entirely (no leftover
 * `enabled = false` line — the absence of the section is the disabled state).
 */
export function removeBraveSearch(authPath: string): { changed: boolean } {
  let changed = false;
  withAuth(authPath, (auth) => {
    if (auth.services?.brave_search) {
      delete auth.services.brave_search;
      changed = true;
    }
    if (auth.tools?.web_search) {
      delete auth.tools.web_search;
      changed = true;
    }
  });
  return { changed };
}

// ─── Internals ────────────────────────────────────────────────────────────────

/**
 * Read-only convenience wrapper. Reads the auth.toml without rewriting it.
 * Used by the `read*` helpers so the read path mirrors the mutation path
 * (both go through `loadAuthToml`'s missing-file handling).
 */
function withAuthRead(authPath: string, inspect: (auth: AuthToml) => void): void {
  inspect(loadAuthToml(authPath));
}

function validateKeysArray(provider: LlmProvider, keys: LlmKey[]): void {
  if (keys.length === 0) {
    throw new Error(`addProviderToApiKeysTier: keys array is empty for ${provider}`);
  }
  const seenLabels = new Set<string>();
  for (const k of keys) {
    if (!k.key) throw new Error(`addProviderToApiKeysTier: empty key value for ${provider}`);
    if (!k.label) throw new Error(`addProviderToApiKeysTier: empty label for ${provider}`);
    if (seenLabels.has(k.label)) {
      throw new Error(`addProviderToApiKeysTier: duplicate label "${k.label}" for ${provider}`);
    }
    seenLabels.add(k.label);
  }
}
