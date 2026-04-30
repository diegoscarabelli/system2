/**
 * Agent model validation.
 *
 * Cross-checks every (provider, modelId) pair declared by agent configs
 * (frontmatter defaults + [agents.<role>.models] overrides) against pi-ai's
 * model catalog. Surfaces typos and retired model ids at startup with a
 * Levenshtein-nearest "did you mean" suggestion, instead of as a runtime API
 * failure deep inside an agent loop.
 *
 * Lives in src/shared/ so both the CLI (config-load time) and the server
 * (AgentHost.loadAgent time) can call it without crossing module boundaries.
 */

import { getModels, getProviders } from '@mariozechner/pi-ai';
import type { AgentsConfig } from './types/config.js';

/**
 * Compute Levenshtein edit distance for did-you-mean suggestions on model id typos.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

// Memoize getProviders() and per-provider getModels() so validation across many
// agents (and across reinitialize/failover paths) doesn't re-walk the catalog.
let knownProviderSet: ReadonlySet<string> | undefined;
const catalogIdsCache = new Map<string, string[]>();

function getKnownProviderSet(): ReadonlySet<string> {
  if (!knownProviderSet) {
    knownProviderSet = new Set(getProviders() as readonly string[]);
  }
  return knownProviderSet;
}

function getCatalogIds(provider: string): string[] | undefined {
  // Returns undefined when the provider isn't in pi-ai's catalog (e.g.,
  // openai-compatible registers its model dynamically at runtime).
  if (!getKnownProviderSet().has(provider)) return undefined;
  const cached = catalogIdsCache.get(provider);
  if (cached) return cached;
  const ids = getModels(provider as Parameters<typeof getModels>[0]).map((m) => m.id);
  catalogIdsCache.set(provider, ids);
  return ids;
}

function nearestModelId(provider: string, attempted: string): string | undefined {
  const ids = getCatalogIds(provider);
  if (!ids) return undefined;
  let best: { id: string; dist: number } | undefined;
  for (const id of ids) {
    const dist = levenshtein(attempted, id);
    if (best === undefined || dist < best.dist) best = { id, dist };
  }
  return best && best.dist <= 3 ? best.id : undefined;
}

/**
 * Providers that intentionally aren't in pi-ai's MODELS catalog and are still
 * acceptable as per-agent overrides — they would be skipped by the "unknown
 * provider" check rather than throwing. Currently empty: `openai-compatible`
 * is NOT a valid per-agent override (its model is set globally via
 * `[llm.openai-compatible].model`), and `convertTomlAgents` already rejects it
 * at TOML-parse time. Kept as an explicit Set so future non-catalog providers
 * can be added without changing the validator's structure.
 */
const DYNAMIC_PROVIDERS: ReadonlySet<string> = new Set();

/**
 * Validate every (provider, modelId) pair declared in an agents config against
 * pi-ai's model catalog. Throws on first mismatch:
 *
 * - Unknown provider id → throws with the list of valid providers.
 * - Provider known but modelId unknown → throws with a Levenshtein-nearest
 *   "did you mean" suggestion.
 *
 * Skips known dynamic providers (DYNAMIC_PROVIDERS) since their model isn't
 * in pi-ai's catalog by design (the user supplies it in config).
 */
export function validateAgentModels(agents: AgentsConfig): void {
  const knownProviders = getKnownProviderSet();
  for (const [role, override] of Object.entries(agents)) {
    if (!override.models) continue;
    for (const [provider, modelId] of Object.entries(override.models)) {
      if (!modelId) continue;
      if (DYNAMIC_PROVIDERS.has(provider)) continue;
      if (!knownProviders.has(provider)) {
        const validProviders = [...knownProviders, ...DYNAMIC_PROVIDERS].sort().join(', ');
        throw new Error(
          `Agent "${role}" references unknown provider "${provider}" in models override. ` +
            `Valid providers: ${validProviders}.`
        );
      }
      const ids = getCatalogIds(provider);
      // ids is guaranteed defined here because provider is in knownProviders.
      if (ids && !ids.includes(modelId)) {
        const nearest = nearestModelId(provider, modelId);
        const suggestion = nearest ? ` Did you mean "${nearest}"?` : '';
        throw new Error(
          `Agent "${role}" references model "${modelId}" for provider "${provider}", ` +
            `which is not in pi-ai's catalog.${suggestion}`
        );
      }
    }
  }
}

/**
 * Reset the memoized catalogs. Test-only helper; do not call in production code.
 * Useful when tests stub pi-ai's getProviders/getModels and need a fresh read.
 */
export function _resetAgentModelsCacheForTests(): void {
  knownProviderSet = undefined;
  catalogIdsCache.clear();
}
