/**
 * OAuth-tier model selection.
 *
 * The OAuth credential tier (`[llm.oauth]`) is flat-fee and capability-oriented:
 * one model per provider, applied to every agent role. This module owns the
 * resolution policy. The API-keys tier still uses the per-role × per-provider
 * matrix configured in agent frontmatter and `[llm.api_keys.<provider>.models]`.
 *
 * Resolution order for a given provider (the host implements user-pin
 * lookup outside this module):
 *   1. User pin in `[llm.oauth.<provider>].model`.
 *   2. Latest pi-ai catalog entry matching `OAUTH_FAMILIES[provider]`.
 *   3. Hardcoded floor `OAUTH_FALLBACKS[provider]`.
 *
 * The fallback is also the runtime step-down target when an auto-resolved
 * model returns 403 or 404 — see `host.ts` for the wiring.
 */

import { getModels, getProviders } from '@mariozechner/pi-ai';
import type { LlmProvider } from './types/config.js';

/**
 * Per-provider regex matching the "flagship family" we want for OAuth users.
 * The resolver picks the latest catalog match via natural-sort.
 *
 * Auto-tracking semantics: when pi-ai catalogs a newer version within the
 * family (e.g. claude-opus-4-8 ships and replaces 4-7), the resolver
 * automatically promotes it without any code change here.
 */
export const OAUTH_FAMILIES: Partial<Record<LlmProvider, RegExp>> = {
  // Anthropic OAuth is paid-only (Pro/Max/Team/Enterprise).
  // Latest opus auto-tracked (today: claude-opus-4-7).
  anthropic: /^claude-opus-/,

  // Codex CLI's flagship family includes plain gpt-X.Y and codex specialty
  // variants (-codex, -codex-max, -codex-spark). Excludes -mini variants.
  // Today: gpt-5.5; auto-tracks gpt-5.6, gpt-6.0-codex, etc.
  'openai-codex': /^gpt-\d+(\.\d+)?(-codex(-max|-spark)?)?$/,

  // Copilot's catalog is multi-vendor (Claude/Gemini/GPT). Default to plain
  // GPT-X.Y line — most reliably reachable across Copilot Free/Pro tiers.
  // Excludes mini, codex, turbo, and gpt-4o suffixed variants.
  // Today: gpt-5.4 (gpt-5.5 in Copilot's catalog when shipped).
  'github-copilot': /^gpt-\d+(\.\d+)?$/,
};

/**
 * Hardcoded fallback model IDs per OAuth provider.
 *
 * Used when:
 *   - The family regex matches nothing in pi-ai's current catalog (e.g.
 *     during a rebrand or catalog gap).
 *   - The auto-resolved family flagship returns 403 or 404 at runtime.
 *
 * Each fallback is verified to be in pi-ai's catalog at the time of writing
 * and chosen to be reachable on the lowest paid (Anthropic) or free
 * (OpenAI Codex, Copilot) tier of the corresponding subscription.
 */
export const OAUTH_FALLBACKS: Partial<Record<LlmProvider, string>> = {
  anthropic: 'claude-sonnet-4-6',
  'openai-codex': 'gpt-5.4',
  'github-copilot': 'gpt-4.1',
};

/** Date-pinned snapshot suffix (e.g. -20251101). Snapshots are filtered out
 *  in favor of the alias they freeze, since the alias auto-tracks future
 *  patches and we want the most-current behavior. */
const SNAPSHOT_RE = /-\d{8,}$/;

let knownProviderSet: ReadonlySet<string> | undefined;
function getKnownProviders(): ReadonlySet<string> {
  if (!knownProviderSet) knownProviderSet = new Set(getProviders() as readonly string[]);
  return knownProviderSet;
}

/**
 * Compare two model IDs in version-aware natural-sort order.
 *
 * Rules, applied left-to-right over `-`/`.`-split segments:
 *   1. Both segments numeric → numeric compare (so 5.10 > 5.4).
 *   2. One numeric, one string → numeric wins (sub-version is newer than
 *      alias-style suffix). E.g. `gemini-3.1-pro` > `gemini-3-pro` because
 *      at position 1 we compare 1 (number) vs 'pro' (string).
 *   3. Both string → lex compare.
 *   4. Tie on shared prefix, longer string wins (more specific version).
 *
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
export function compareNatural(a: string, b: string): number {
  const A = a.split(/[-.]/);
  const B = b.split(/[-.]/);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const av = A[i];
    const bv = B[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    const aN = /^\d+$/.test(av) ? +av : null;
    const bN = /^\d+$/.test(bv) ? +bv : null;
    if (aN !== null && bN !== null) {
      if (aN !== bN) return aN - bN;
    } else if (aN !== null) {
      return 1;
    } else if (bN !== null) {
      return -1;
    } else if (av !== bv) {
      return av < bv ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Pick the latest catalog entry for `provider` matching its family regex.
 * Filters out date-snapshot variants in favor of aliases. Returns undefined
 * when the provider isn't in pi-ai's catalog or no matches are found.
 */
function pickFromFamily(provider: LlmProvider): string | undefined {
  const family = OAUTH_FAMILIES[provider];
  if (!family) return undefined;
  if (!getKnownProviders().has(provider)) return undefined;
  const ids = getModels(provider as Parameters<typeof getModels>[0]).map((m) => m.id);
  const matches = ids.filter((id) => family.test(id));
  if (matches.length === 0) return undefined;
  const aliases = matches.filter((id) => !SNAPSHOT_RE.test(id));
  const pool = aliases.length > 0 ? aliases : matches;
  return pool.sort((a, b) => compareNatural(b, a))[0];
}

/**
 * Resolve the OAuth-tier model for `provider`. Returns the family flagship
 * if pi-ai's catalog has one matching `OAUTH_FAMILIES[provider]`, else the
 * hardcoded `OAUTH_FALLBACKS[provider]`. Returns undefined when neither
 * exists — caller should refuse to use OAuth for that provider.
 */
export function resolveOAuthModel(provider: LlmProvider): string | undefined {
  return pickFromFamily(provider) ?? OAUTH_FALLBACKS[provider];
}
