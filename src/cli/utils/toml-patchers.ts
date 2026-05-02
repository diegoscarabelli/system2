/**
 * TOML patchers for `~/.system2/config.toml`.
 *
 * Each patcher reads the file, parses it with @iarna/toml to inspect current
 * state, then edits the raw text via line-anchored regex and writes back. The
 * regex approach preserves comments, blank lines, and section dividers that
 * `buildConfigToml` emits — round-tripping through a serializer would flatten
 * everything.
 *
 * All patchers return `{ changed: boolean }`. They throw when the file or a
 * required section is missing, or when the on-disk format is so unusual the
 * regex can't find what TOML.parse can.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import TOML from '@iarna/toml';
import type { LlmKey, LlmProvider } from '../../shared/index.js';

// ─── OAuth tier ───────────────────────────────────────────────────────────────

/**
 * Pattern matching the [llm.oauth] block: header line + immediate key=value
 * lines (typically primary + fallback), stopping at the first blank line,
 * comment line, or next `[`-section header.
 *
 * Prior versions used a wide pattern that ran to the next live `[`-section,
 * which silently consumed everything in between — fine when adjacent
 * sections were always live, but corrupting once buildConfigToml started
 * emitting commented templates and dividers between live sections. The
 * narrow pattern preserves those structural elements (and any
 * `[llm.oauth.<provider>]` sub-section model pins, which sit below a blank
 * line and so are now also preserved).
 */
const OAUTH_BLOCK_PATTERN = /^\[llm\.oauth\][^\n]*\n(?:[^[#\s][^\n]*\n)+/m;

/**
 * Read the current `[llm.oauth]` tier from config.toml.
 * Returns null if the section is absent.
 */
export function readOAuthTier(configPath: string): { primary: string; fallback: string[] } | null {
  if (!existsSync(configPath)) return null;
  const parsed = TOML.parse(readFileSync(configPath, 'utf-8')) as {
    llm?: { oauth?: { primary?: string; fallback?: string[] } };
  };
  const oauth = parsed.llm?.oauth;
  if (!oauth?.primary) return null;
  return { primary: oauth.primary, fallback: oauth.fallback ?? [] };
}

/**
 * Patch config.toml to include `provider` in the OAuth tier (`[llm.oauth]`).
 * If the section is missing, create it with `provider` as primary and empty fallback.
 * If present with a different primary, append `provider` to fallback.
 * If `provider` is already in the tier, no-op.
 *
 * Returns { changed: boolean }.
 */
export function addProviderToOAuthTier(
  configPath: string,
  provider: LlmProvider
): { changed: boolean } {
  if (!existsSync(configPath)) {
    throw new Error(`config.toml not found at ${configPath}`);
  }
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = TOML.parse(raw) as { llm?: { oauth?: { primary?: string; fallback?: string[] } } };
  const oauth = parsed.llm?.oauth;

  if (!oauth) {
    const insertion = `[llm.oauth]\nprimary = "${provider}"\nfallback = []\n`;
    const lines = raw.split('\n');
    const llmHeaderIdx = lines.findIndex((l) => l.trim() === '[llm]');
    if (llmHeaderIdx === -1) {
      // No [llm] block. Append at end (preserve trailing newline behavior).
      const sep = raw.endsWith('\n') ? '' : '\n';
      writeFileSync(configPath, `${raw}${sep}\n${insertion}`);
      return { changed: true };
    }
    // Find end of [llm] block: next line that starts a new table, or EOF
    let insertIdx = lines.length;
    for (let i = llmHeaderIdx + 1; i < lines.length; i++) {
      if (/^\[/.test(lines[i].trim())) {
        insertIdx = i;
        break;
      }
    }
    // Skip any blank lines immediately before the next section so we insert *before* the blank line
    while (insertIdx > llmHeaderIdx + 1 && lines[insertIdx - 1].trim() === '') {
      insertIdx--;
    }
    lines.splice(insertIdx, 0, '', `[llm.oauth]`, `primary = "${provider}"`, 'fallback = []');
    writeFileSync(configPath, lines.join('\n'));
    return { changed: true };
  }

  const inTier = oauth.primary === provider || (oauth.fallback ?? []).includes(provider);
  if (inTier) return { changed: false };

  // Append to fallback array. Capture ONLY the [llm.oauth] header + its
  // immediate key=value lines, stopping at the first blank line, comment,
  // or next `[`-section. A wider span would include intervening commented
  // templates and section dividers (which buildConfigToml emits between
  // tiers); replacing that span destroys structure.
  const match = raw.match(OAUTH_BLOCK_PATTERN);
  if (!match) {
    // TOML.parse found [llm.oauth] but the regex doesn't match — likely an
    // unusual on-disk format (leading whitespace before the header, key on
    // same line as header, etc.). Throw rather than silently no-op: the
    // credential file has already been written, so a silent miss here would
    // leave the user logged in but not registered in [llm.oauth].
    throw new Error(
      `Could not locate [llm.oauth] section in ${configPath} for rewrite. ` +
        `Edit the file manually if it has unusual formatting.`
    );
  }
  const newFallback = [...(oauth.fallback ?? []), provider];
  const fallbackLine = `fallback = [${newFallback.map((f) => `"${f}"`).join(', ')}]`;
  const replacedSection = match[0].replace(/fallback\s*=\s*\[[^\]]*\]/, fallbackLine);

  // If regex didn't match an existing fallback line, the section is unchanged.
  // We need to insert the fallback line after the primary line instead.
  if (replacedSection === match[0]) {
    const withFallback = match[0].replace(/(primary\s*=\s*"[^"]*"\s*\n)/, `$1${fallbackLine}\n`);
    if (withFallback === match[0]) {
      // No primary= line either — same partial-success risk as a regex miss.
      throw new Error(
        `Could not locate primary= line in [llm.oauth] section of ${configPath} ` +
          `to anchor a fallback insertion. Edit the file manually.`
      );
    }
    writeFileSync(configPath, raw.replace(OAUTH_BLOCK_PATTERN, withFallback));
    return { changed: true };
  }

  writeFileSync(configPath, raw.replace(OAUTH_BLOCK_PATTERN, replacedSection));
  return { changed: true };
}

/**
 * Patch config.toml to remove `provider` from `[llm.oauth]`.
 * - If `provider` is the primary and there's a fallback: promote the first fallback to primary.
 * - If `provider` is the primary and no fallback: drop the `[llm.oauth]` section entirely.
 * - If `provider` is in fallback: remove it from the fallback list.
 * - If `provider` not in the tier: no-op.
 */
export function removeProviderFromOAuthTier(
  configPath: string,
  provider: LlmProvider
): { changed: boolean } {
  if (!existsSync(configPath)) {
    throw new Error(`config.toml not found at ${configPath}`);
  }
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = TOML.parse(raw) as { llm?: { oauth?: { primary?: string; fallback?: string[] } } };
  const oauth = parsed.llm?.oauth;
  if (!oauth) return { changed: false };

  const fallback = oauth.fallback ?? [];
  const isPrimary = oauth.primary === provider;
  const inFallback = fallback.includes(provider);
  if (!isPrimary && !inFallback) return { changed: false };

  let newPrimary: string | null = oauth.primary ?? null;
  let newFallback = fallback.slice();

  if (isPrimary) {
    newPrimary = newFallback.length > 0 ? (newFallback.shift() ?? null) : null;
  } else {
    newFallback = newFallback.filter((f) => f !== provider);
  }

  if (!OAUTH_BLOCK_PATTERN.test(raw)) {
    throw new Error(
      `Could not locate [llm.oauth] section in ${configPath} for rewrite. ` +
        `Edit the file manually if it has unusual formatting.`
    );
  }

  if (newPrimary === null) {
    writeFileSync(configPath, raw.replace(OAUTH_BLOCK_PATTERN, ''));
    return { changed: true };
  }

  const fbStr = newFallback.map((f) => `"${f}"`).join(', ');
  const replacement = `[llm.oauth]\nprimary = "${newPrimary}"\nfallback = [${fbStr}]\n`;
  writeFileSync(configPath, raw.replace(OAUTH_BLOCK_PATTERN, replacement));
  return { changed: true };
}

/**
 * Overwrite `[llm.oauth].fallback` with the supplied ordered list. Validates
 * that no entry equals the current primary (use `setProviderAsPrimary` to
 * change the primary). If the new order matches the current `fallback` exactly,
 * this is a no-op (no file write).
 */
export function setOAuthFallbackOrder(
  configPath: string,
  newFallback: LlmProvider[]
): { changed: boolean } {
  const current = readOAuthTier(configPath);
  if (!current) {
    throw new Error(`[llm.oauth] section not found in ${configPath}`);
  }
  if (newFallback.some((entry) => entry === current.primary)) {
    throw new Error(`primary cannot appear in fallback: ${current.primary}`);
  }
  const same =
    newFallback.length === current.fallback.length &&
    newFallback.every((p, i) => p === current.fallback[i]);
  if (same) return { changed: false };

  const raw = readFileSync(configPath, 'utf-8');
  if (!OAUTH_BLOCK_PATTERN.test(raw)) {
    throw new Error(
      `Could not locate [llm.oauth] section in ${configPath} for rewrite. ` +
        `Edit the file manually if it has unusual formatting.`
    );
  }
  const fbStr = newFallback.map((f) => `"${f}"`).join(', ');
  const replacement = `[llm.oauth]\nprimary = "${current.primary}"\nfallback = [${fbStr}]\n`;
  writeFileSync(configPath, raw.replace(OAUTH_BLOCK_PATTERN, replacement));
  return { changed: true };
}

/**
 * Promote `provider` to primary in `[llm.oauth]`. The current primary becomes the
 * head of fallback (preserving the rest of fallback's order). If `provider` is
 * already primary, no-op.
 */
export function setProviderAsPrimary(
  configPath: string,
  provider: LlmProvider
): { changed: boolean } {
  const current = readOAuthTier(configPath);
  if (!current) {
    throw new Error(`[llm.oauth] section not found in ${configPath}`);
  }
  if (current.primary === provider) return { changed: false };

  // Move current primary to head of fallback. Strip provider from fallback if
  // it was there, then prepend the old primary.
  const newFallback = [current.primary, ...current.fallback.filter((f) => f !== provider)];

  const raw = readFileSync(configPath, 'utf-8');
  if (!OAUTH_BLOCK_PATTERN.test(raw)) {
    throw new Error(
      `Could not locate [llm.oauth] section in ${configPath} for rewrite. ` +
        `Edit the file manually if it has unusual formatting.`
    );
  }
  const fbStr = newFallback.map((f) => `"${f}"`).join(', ');
  const replacement = `[llm.oauth]\nprimary = "${provider}"\nfallback = [${fbStr}]\n`;
  writeFileSync(configPath, raw.replace(OAUTH_BLOCK_PATTERN, replacement));
  return { changed: true };
}

// ─── API-keys tier ────────────────────────────────────────────────────────────

/**
 * Mirrors OAUTH_BLOCK_PATTERN but for `[llm.api_keys]`. Matches the bare tier
 * header line (`[llm.api_keys]`) plus its key=value lines (primary, fallback),
 * stopping at the first blank line, comment line, or any next `[`-section
 * header (including the `[llm.api_keys.<provider>]` sub-sections that follow).
 *
 * The literal `]` after `api_keys` ensures we don't match a `[llm.api_keys.x]`
 * sub-section header by accident: the regex needs `]` next, sub-sections have
 * `.` next.
 */
const API_KEYS_BLOCK_PATTERN = /^\[llm\.api_keys\][^\n]*\n(?:[^[#\s][^\n]*\n)+/m;

/**
 * Read the current `[llm.api_keys]` tier from config.toml.
 * Returns null if the section is absent.
 */
export function readApiKeysTier(
  configPath: string
): { primary: string; fallback: string[]; providers: Set<string> } | null {
  if (!existsSync(configPath)) return null;
  const parsed = TOML.parse(readFileSync(configPath, 'utf-8')) as {
    llm?: {
      api_keys?: Record<string, unknown> & { primary?: string; fallback?: string[] };
    };
  };
  const tier = parsed.llm?.api_keys;
  if (!tier?.primary) return null;
  const providers = new Set<string>();
  for (const k of Object.keys(tier)) {
    if (k !== 'primary' && k !== 'fallback') providers.add(k);
  }
  return { primary: tier.primary, fallback: tier.fallback ?? [], providers };
}

/**
 * Format a `keys = [...]` array as a multi-line block for inclusion in a sub-section.
 */
function formatKeysBlock(keys: LlmKey[]): string {
  const lines = ['keys = ['];
  for (const k of keys) {
    lines.push(`  { key = "${k.key}", label = "${k.label}" },`);
  }
  lines.push(']');
  return lines.join('\n');
}

/**
 * Add a new provider to the API-keys tier with its initial key list.
 * - If [llm.api_keys] is absent, create it with `provider` as primary, empty fallback.
 * - If [llm.api_keys] exists and `provider` is not in the tier, append to fallback.
 * - If `provider` is already in the tier, throw (use addKeyToApiKeyProvider to add more keys).
 *
 * Always writes a corresponding [llm.api_keys.<provider>] subsection with the supplied keys.
 */
export function addProviderToApiKeysTier(
  configPath: string,
  provider: LlmProvider,
  keys: LlmKey[]
): { changed: boolean } {
  if (!existsSync(configPath)) {
    throw new Error(`config.toml not found at ${configPath}`);
  }
  const current = readApiKeysTier(configPath);
  if (current && (current.primary === provider || current.fallback.includes(provider))) {
    throw new Error(`${provider} already in [llm.api_keys]`);
  }

  const raw = readFileSync(configPath, 'utf-8');
  const subsection = `\n[llm.api_keys.${provider}]\n${formatKeysBlock(keys)}\n`;

  if (!current) {
    // Create [llm.api_keys] with this provider as primary, plus its sub-section.
    const block = `\n[llm.api_keys]\nprimary = "${provider}"\nfallback = []\n${subsection}`;
    const sep = raw.endsWith('\n') ? '' : '\n';
    writeFileSync(configPath, `${raw}${sep}${block}`);
    return { changed: true };
  }

  // Append provider to fallback array, then append sub-section at end of file.
  const newFallback = [...current.fallback, provider];
  if (!API_KEYS_BLOCK_PATTERN.test(raw)) {
    throw new Error(
      `Could not locate [llm.api_keys] section in ${configPath} for rewrite. ` +
        `Edit the file manually if it has unusual formatting.`
    );
  }
  const fbStr = newFallback.map((f) => `"${f}"`).join(', ');
  const tierReplacement = `[llm.api_keys]\nprimary = "${current.primary}"\nfallback = [${fbStr}]\n`;
  const withTier = raw.replace(API_KEYS_BLOCK_PATTERN, tierReplacement);
  const sep = withTier.endsWith('\n') ? '' : '\n';
  writeFileSync(configPath, `${withTier}${sep}${subsection}`);
  return { changed: true };
}

/**
 * Find the line range [start, end) for a section starting with `headerLine`.
 * `end` is the index of the next section header line, or `lines.length`.
 * Trailing blank lines BEFORE the next header are included in the range so
 * that removing the section removes its blank-line padding.
 */
function findSectionLineRange(lines: string[], headerLine: string): [number, number] | null {
  const start = lines.findIndex((l) => l.trim() === headerLine);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  // Include trailing blank lines so the deletion doesn't leave a double blank.
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  return [start, end];
}

/**
 * Remove a provider from `[llm.api_keys]`:
 * - If `provider` is the primary and fallback is non-empty: promote head of fallback.
 * - If `provider` is the primary and fallback is empty: drop the entire `[llm.api_keys]` section.
 * - If `provider` is in fallback: remove from fallback list.
 * - If `provider` not in tier: no-op.
 *
 * In every changing case, also delete `[llm.api_keys.<provider>]` and any
 * `[llm.api_keys.<provider>.<sub>]` sub-sub-sections (e.g., `.models`, `.routing`).
 */
export function removeProviderFromApiKeysTier(
  configPath: string,
  provider: LlmProvider
): { changed: boolean } {
  if (!existsSync(configPath)) {
    throw new Error(`config.toml not found at ${configPath}`);
  }
  const current = readApiKeysTier(configPath);
  if (!current) return { changed: false };

  const isPrimary = current.primary === provider;
  const inFallback = current.fallback.includes(provider);
  if (!isPrimary && !inFallback) return { changed: false };

  let newPrimary: string | null = current.primary;
  let newFallback = current.fallback.slice();
  if (isPrimary) {
    newPrimary = newFallback.length > 0 ? (newFallback.shift() ?? null) : null;
  } else {
    newFallback = newFallback.filter((f) => f !== provider);
  }

  const raw = readFileSync(configPath, 'utf-8');

  // First, rewrite or remove the [llm.api_keys] tier block.
  let next = raw;
  if (!API_KEYS_BLOCK_PATTERN.test(next)) {
    throw new Error(
      `Could not locate [llm.api_keys] section in ${configPath} for rewrite. ` +
        `Edit the file manually if it has unusual formatting.`
    );
  }
  if (newPrimary === null) {
    next = next.replace(API_KEYS_BLOCK_PATTERN, '');
  } else {
    const fbStr = newFallback.map((f) => `"${f}"`).join(', ');
    const replacement = `[llm.api_keys]\nprimary = "${newPrimary}"\nfallback = [${fbStr}]\n`;
    next = next.replace(API_KEYS_BLOCK_PATTERN, replacement);
  }

  // Then remove [llm.api_keys.<provider>] and any [llm.api_keys.<provider>.<sub>] children.
  // Line-based to handle multi-line keys arrays and nested sub-sections cleanly.
  const lines = next.split('\n');
  const headersToRemove: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed === `[llm.api_keys.${provider}]` ||
      trimmed.startsWith(`[llm.api_keys.${provider}.`)
    ) {
      headersToRemove.push(trimmed);
    }
  }
  let workingLines = lines;
  for (const header of headersToRemove) {
    const range = findSectionLineRange(workingLines, header);
    if (!range) continue;
    workingLines = [...workingLines.slice(0, range[0]), ...workingLines.slice(range[1])];
  }
  next = workingLines.join('\n');

  // Collapse runs of 3+ blank lines to 2 to avoid visual gaps from removed sections.
  next = next.replace(/\n{3,}/g, '\n\n');

  writeFileSync(configPath, next);
  return { changed: true };
}

/**
 * Promote `provider` to primary in `[llm.api_keys]`. The current primary becomes
 * the head of fallback (preserving the rest of fallback's order). If `provider`
 * is already primary, no-op.
 */
export function setApiKeyProviderAsPrimary(
  configPath: string,
  provider: LlmProvider
): { changed: boolean } {
  const current = readApiKeysTier(configPath);
  if (!current) {
    throw new Error(`[llm.api_keys] section not found in ${configPath}`);
  }
  if (current.primary === provider) return { changed: false };

  const newFallback = [current.primary, ...current.fallback.filter((f) => f !== provider)];
  const raw = readFileSync(configPath, 'utf-8');
  if (!API_KEYS_BLOCK_PATTERN.test(raw)) {
    throw new Error(
      `Could not locate [llm.api_keys] section in ${configPath} for rewrite. ` +
        `Edit the file manually if it has unusual formatting.`
    );
  }
  const fbStr = newFallback.map((f) => `"${f}"`).join(', ');
  const replacement = `[llm.api_keys]\nprimary = "${provider}"\nfallback = [${fbStr}]\n`;
  writeFileSync(configPath, raw.replace(API_KEYS_BLOCK_PATTERN, replacement));
  return { changed: true };
}

/**
 * Overwrite `[llm.api_keys].fallback` with the supplied ordered list. Validates
 * that no entry equals the current primary. No-op if order matches current.
 */
export function setApiKeysFallbackOrder(
  configPath: string,
  newFallback: LlmProvider[]
): { changed: boolean } {
  const current = readApiKeysTier(configPath);
  if (!current) {
    throw new Error(`[llm.api_keys] section not found in ${configPath}`);
  }
  if (newFallback.some((entry) => entry === current.primary)) {
    throw new Error(`primary cannot appear in fallback: ${current.primary}`);
  }
  const same =
    newFallback.length === current.fallback.length &&
    newFallback.every((p, i) => p === current.fallback[i]);
  if (same) return { changed: false };

  const raw = readFileSync(configPath, 'utf-8');
  if (!API_KEYS_BLOCK_PATTERN.test(raw)) {
    throw new Error(
      `Could not locate [llm.api_keys] section in ${configPath} for rewrite. ` +
        `Edit the file manually if it has unusual formatting.`
    );
  }
  const fbStr = newFallback.map((f) => `"${f}"`).join(', ');
  const replacement = `[llm.api_keys]\nprimary = "${current.primary}"\nfallback = [${fbStr}]\n`;
  writeFileSync(configPath, raw.replace(API_KEYS_BLOCK_PATTERN, replacement));
  return { changed: true };
}

/**
 * Match the multi-line `keys = [...]` block inside a `[llm.api_keys.<provider>]`
 * sub-section. Captures the assignment (`keys = `) so the caller can rebuild it,
 * then matches everything up to the closing `]` on its own line.
 */
function buildKeysBlockPattern(provider: string): RegExp {
  // Match the sub-section header, then capture the keys = [ ... ] block specifically.
  return new RegExp(
    `(\\[llm\\.api_keys\\.${provider}\\][\\s\\S]*?keys\\s*=\\s*)\\[[\\s\\S]*?\\n\\]`,
    'm'
  );
}

/**
 * Add a key (key + label) to an existing `[llm.api_keys.<provider>]` sub-section.
 * Throws if the sub-section doesn't exist or if the label collides.
 */
export function addKeyToApiKeyProvider(
  configPath: string,
  provider: LlmProvider,
  key: LlmKey
): { changed: boolean } {
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = TOML.parse(raw) as {
    llm?: { api_keys?: Record<string, unknown> };
  };
  const sub = parsed.llm?.api_keys?.[provider] as { keys?: LlmKey[] } | undefined;
  if (!sub) {
    throw new Error(`[llm.api_keys.${provider}] not found in ${configPath}`);
  }
  const existing = sub.keys ?? [];
  if (existing.some((k) => k.label === key.label)) {
    throw new Error(`label "${key.label}" already exists for ${provider}`);
  }
  const newKeys = [...existing, key];
  const pattern = buildKeysBlockPattern(provider);
  if (!pattern.test(raw)) {
    throw new Error(`Could not locate keys array for ${provider} in ${configPath}`);
  }
  writeFileSync(
    configPath,
    raw.replace(pattern, `$1${formatKeysBlock(newKeys).slice('keys = '.length)}`)
  );
  return { changed: true };
}

/**
 * Remove a key by label from `[llm.api_keys.<provider>]`. Throws if removing
 * would leave the provider with zero keys (caller should use
 * `removeProviderFromApiKeysTier` instead).
 */
export function removeKeyFromApiKeyProvider(
  configPath: string,
  provider: LlmProvider,
  label: string
): { changed: boolean } {
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = TOML.parse(raw) as {
    llm?: { api_keys?: Record<string, unknown> };
  };
  const sub = parsed.llm?.api_keys?.[provider] as { keys?: LlmKey[] } | undefined;
  if (!sub) {
    throw new Error(`[llm.api_keys.${provider}] not found in ${configPath}`);
  }
  const existing = sub.keys ?? [];
  const newKeys = existing.filter((k) => k.label !== label);
  if (newKeys.length === existing.length) return { changed: false };
  if (newKeys.length === 0) {
    throw new Error(
      `cannot remove the last key for ${provider}; use removeProviderFromApiKeysTier instead`
    );
  }
  const pattern = buildKeysBlockPattern(provider);
  if (!pattern.test(raw)) {
    throw new Error(`Could not locate keys array for ${provider} in ${configPath}`);
  }
  writeFileSync(
    configPath,
    raw.replace(pattern, `$1${formatKeysBlock(newKeys).slice('keys = '.length)}`)
  );
  return { changed: true };
}
