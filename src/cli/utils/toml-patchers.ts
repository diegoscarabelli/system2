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

/**
 * Escape a string for inclusion in a TOML basic (double-quoted) string. User
 * input (API keys, labels, URLs) can legitimately contain `\`, `"`, or control
 * characters; without escaping these would produce invalid TOML or, in
 * adversarial cases, let an attacker inject trailing TOML syntax. Provider IDs
 * come from a fixed enum (`LlmProvider`) and don't need escaping, but
 * labels/keys/urls do.
 *
 * Escape order matters: backslash MUST be replaced first or every later
 * substitution that introduces a `\` would be re-escaped on the next pass.
 *
 * Note: `/\b/g` in a regex is a word boundary, NOT the backspace control char.
 * Use the explicit character class `/[\b]/g` for the rare backspace case.
 */
export function escapeTomlString(s: string): string {
  return (
    s
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/[\b]/g, '\\b')
      .replace(/\t/g, '\\t')
      .replace(/\n/g, '\\n')
      .replace(/\f/g, '\\f')
      .replace(/\r/g, '\\r')
      // Catch-all: any remaining C0 control char (U+0000..U+001F minus those
      // handled above, plus DEL U+007F) is illegal in a TOML basic string per
      // spec. Emit as a \\uXXXX escape rather than dropping or leaving raw, so
      // escapeTomlString can never produce invalid TOML for any input. The
      // control-char range in the regex is intentional; biome's
      // noControlCharactersInRegex would otherwise flag both U+0000 and U+007F.
      .replace(
        // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char escape
        /[\u0000-\u001f\u007f]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
      )
  );
}

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
    // Preferred: replace the commented stub buildConfigToml emits when no
    // OAuth is configured (the 3 lines `# [llm.oauth]\n# primary = "..."\n
    // # fallback = [...]`). Without this, the live block lands at EOF (or
    // after [llm]) and the commented stub stays put — leaving a confusing
    // duplicate schema on first `system2 config` run.
    const stubReplaced = raw.replace(
      /^# \[llm\.oauth\]\n# primary\s*=\s*"[^"]*"\n# fallback\s*=\s*\[[^\]]*\]\n/m,
      insertion
    );
    if (stubReplaced !== raw) {
      writeFileSync(configPath, stubReplaced);
      return { changed: true };
    }

    const lines = raw.split('\n');
    const llmHeaderIdx = lines.findIndex((l) => l.trim() === '[llm]');
    if (llmHeaderIdx === -1) {
      // No [llm] block and no commented stub. Append at end.
      const sep = raw.endsWith('\n') ? '' : '\n';
      writeFileSync(configPath, `${raw}${sep}\n${insertion}`);
      return { changed: true };
    }
    let insertIdx = lines.length;
    for (let i = llmHeaderIdx + 1; i < lines.length; i++) {
      if (/^\[/.test(lines[i].trim())) {
        insertIdx = i;
        break;
      }
    }
    while (insertIdx > llmHeaderIdx + 1 && lines[insertIdx - 1].trim() === '') {
      insertIdx--;
    }
    lines.splice(insertIdx, 0, '', `[llm.oauth]`, `primary = "${provider}"`, 'fallback = []');
    writeFileSync(configPath, lines.join('\n'));
    return { changed: true };
  }

  // Defense against malformed OAuth tier (header present, primary missing).
  // Mirrors the API-keys-tier guard. Without this, the fallback-rewrite below
  // would interpolate `undefined` as the primary value and produce invalid
  // TOML, or leave the tier in a no-primary state the runtime can't use.
  if (!oauth.primary) {
    throw new Error(
      `[llm.oauth] section exists in ${configPath} but is malformed (missing primary?). ` +
        'Edit the file manually to fix it before adding providers via system2 config.'
    );
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

  // Guard against a malformed [llm.oauth] block (header present, primary
  // absent). Without this, removing a fallback entry would leave newPrimary
  // null → the section-deletion branch below fires and wipes the entire
  // [llm.oauth] block, even though the user only asked to remove a fallback.
  // Mirrors the addProviderToOAuthTier guard.
  if (!oauth.primary) {
    throw new Error(
      `[llm.oauth] section exists in ${configPath} but is malformed (missing primary?). ` +
        'Edit the file manually to fix it before removing providers via system2 config.'
    );
  }

  const fallback = oauth.fallback ?? [];
  const isPrimary = oauth.primary === provider;
  const inFallback = fallback.includes(provider);
  if (!isPrimary && !inFallback) return { changed: false };

  let newPrimary: string | null = oauth.primary;
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
 * Format a `keys = [...]` array as a multi-line block for inclusion in a
 * sub-section. Both `key` and `label` are user input — escape via
 * `escapeTomlString` so backslashes/quotes/control characters can't produce
 * invalid TOML or inject trailing syntax.
 */
function formatKeysBlock(keys: LlmKey[]): string {
  const lines = ['keys = ['];
  for (const k of keys) {
    lines.push(`  { key = "${escapeTomlString(k.key)}", label = "${escapeTomlString(k.label)}" },`);
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
  // Validate the keys array up-front. Later operations (replace/remove by
  // label) address keys by their `label`, so duplicate labels would leave
  // the provider in an ambiguous state. Empty keys/labels would silently
  // succeed at parse time but break runtime auth resolution. Surface these
  // as clear errors here rather than letting them rot until first use.
  if (keys.length === 0) {
    throw new Error(`addProviderToApiKeysTier: keys array is empty for ${provider}`);
  }
  const seenLabels = new Set<string>();
  for (const k of keys) {
    if (!k.key) {
      throw new Error(`addProviderToApiKeysTier: empty key value for ${provider}`);
    }
    if (!k.label) {
      throw new Error(`addProviderToApiKeysTier: empty label for ${provider}`);
    }
    if (seenLabels.has(k.label)) {
      throw new Error(`addProviderToApiKeysTier: duplicate label "${k.label}" for ${provider}`);
    }
    seenLabels.add(k.label);
  }
  const current = readApiKeysTier(configPath);
  if (current && (current.primary === provider || current.fallback.includes(provider))) {
    throw new Error(`${provider} already in [llm.api_keys]`);
  }

  const raw = readFileSync(configPath, 'utf-8');

  // Defense against `readApiKeysTier`'s null-when-malformed conflation: it
  // returns null both when [llm.api_keys] is absent AND when it exists but
  // lacks `primary`. In the second case, falling through to the "create tier"
  // branch below would append a second [llm.api_keys] block alongside the
  // existing malformed one — duplicate `primary`/`fallback` assignments which
  // make config.toml unparseable.
  // Two regexes are needed: API_KEYS_BLOCK_PATTERN matches the header plus
  // at least one key=value line (typical malformed: header + only fallback).
  // API_KEYS_HEADER_ONLY_PATTERN matches a bare header with NO body lines
  // (typical malformed: user typed `[llm.api_keys]` and nothing else). Either
  // shape means the tier is present-but-malformed; refuse rather than append.
  const headerOnly = /^\[llm\.api_keys\]\s*$/m;
  if (!current && (API_KEYS_BLOCK_PATTERN.test(raw) || headerOnly.test(raw))) {
    throw new Error(
      `[llm.api_keys] section exists in ${configPath} but is malformed (missing primary?). ` +
        'Edit the file manually to fix it before adding providers via system2 config.'
    );
  }

  // Also guard the appended sub-section: TOML.parse will accept duplicate
  // [llm.api_keys.<provider>] sections but our patchers can't reason about
  // multiple of them, and they confuse readers. Detect via header regex.
  const dupSubPattern = new RegExp(`^\\[llm\\.api_keys\\.${provider}\\]`, 'm');
  if (dupSubPattern.test(raw)) {
    throw new Error(
      `[llm.api_keys.${provider}] sub-section already exists in ${configPath}. ` +
        'This usually indicates a malformed file; edit manually to deduplicate before retrying.'
    );
  }

  const subsection = `\n[llm.api_keys.${provider}]\n${formatKeysBlock(keys)}\n`;

  if (!current) {
    const tierBlock = `[llm.api_keys]\nprimary = "${provider}"\nfallback = []\n`;
    // Preferred: replace the commented stub buildConfigToml emits when no
    // API-keys provider is configured (the 3 lines `# [llm.api_keys]\n
    // # primary = "..."\n# fallback = [...]`). Without this, the live tier
    // block lands at EOF and the commented stub stays put — leaving a
    // confusing duplicate schema on first `system2 config` run.
    const stubReplaced = raw.replace(
      /^# \[llm\.api_keys\]\n# primary\s*=\s*"[^"]*"\n# fallback\s*=\s*\[[^\]]*\]\n/m,
      tierBlock
    );
    if (stubReplaced !== raw) {
      // The stub matched; append the sub-section at end of file (the commented
      // example sub-section in the stub is retained and ignored at parse time).
      const sep = stubReplaced.endsWith('\n') ? '' : '\n';
      writeFileSync(configPath, `${stubReplaced}${sep}${subsection}`);
      return { changed: true };
    }
    // No stub. Append both at end.
    const sep = raw.endsWith('\n') ? '' : '\n';
    writeFileSync(configPath, `${raw}${sep}\n${tierBlock}${subsection}`);
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
 * `end` is the index of the next section header line, or `lines.length`,
 * and is rolled back to skip any trailing blank lines that visually belong
 * to the next section (a divider's blank-line gutter). Removing this range
 * leaves the next section's leading blank lines intact, so dividers and
 * spacing aren't accidentally consumed.
 */
function findSectionLineRange(lines: string[], headerLine: string): [number, number] | null {
  const start = lines.findIndex((l) => l.trim() === headerLine);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    // Trim consistency: `start` matched against `l.trim()`; the next-header
    // detection has to do the same so an indented `[next]` is recognised as a
    // section boundary and we don't run past it deleting unrelated content.
    if (/^\[/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  // Roll `end` back past any trailing blank lines so they STAY (they belong to
  // the next section's leading gutter). Removing the section then leaves the
  // next section's spacing intact.
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
  if (!existsSync(configPath)) {
    throw new Error(`config.toml not found at ${configPath}`);
  }
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
  if (!existsSync(configPath)) {
    throw new Error(`config.toml not found at ${configPath}`);
  }
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
      `cannot remove the last key for ${provider}; use removeProviderFromApiKeysTier instead. ` +
        'To swap the value while keeping the label, use replaceKeyInApiKeyProvider.'
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

// ─── Services: Brave Search ───────────────────────────────────────────────────

const BRAVE_SECTION_PATTERN = /^\[services\.brave_search\][^\n]*\n(?:[^[#\s][^\n]*\n)+/m;
const WEB_SEARCH_SECTION_PATTERN = /^\[tools\.web_search\][^\n]*\n(?:[^[#\s][^\n]*\n)+/m;

/**
 * Set or replace the Brave Search API key. Always also enables `[tools.web_search]`
 * (Brave Search is useless without it). If `[tools.web_search]` already exists,
 * its content is preserved (we only add it when it doesn't exist).
 */
export function setBraveSearchKey(configPath: string, apiKey: string): { changed: boolean } {
  if (!existsSync(configPath)) {
    throw new Error(`config.toml not found at ${configPath}`);
  }
  const raw = readFileSync(configPath, 'utf-8');
  let next = raw;

  // Brave Search section. Three placements, in priority order:
  //   1. Live `[services.brave_search]` exists → rewrite the key in place.
  //   2. Commented stub `# [services.brave_search]\n# key = "..."` exists →
  //      replace the stub with a live block (matches the OAuth/api-keys patcher
  //      stub-replacement pattern; without this, the live block lands at EOF
  //      and the commented stub stays put — confusing duplicate schema).
  //   3. Neither exists → append at end.
  const braveLiveBlock = `[services.brave_search]\nkey = "${escapeTomlString(apiKey)}"\n`;
  // Header-only detection: a bare `[services.brave_search]` with no body
  // bypasses BRAVE_SECTION_PATTERN (which requires at least one key=value
  // line). Without this, we'd fall through to stub or EOF append and end up
  // with two `[services.brave_search]` headers in the file — duplicate
  // tables, parsers reject. Same class as the [llm.api_keys] header-only
  // guard in addProviderToApiKeysTier.
  const braveHeaderOnly = /^\[services\.brave_search\]\s*$/m;
  if (BRAVE_SECTION_PATTERN.test(next)) {
    next = next.replace(BRAVE_SECTION_PATTERN, braveLiveBlock);
  } else if (braveHeaderOnly.test(next)) {
    next = next.replace(braveHeaderOnly, braveLiveBlock.replace(/\n$/, ''));
  } else {
    const braveStubPattern = /^# \[services\.brave_search\]\n# key\s*=\s*"[^"]*"\n/m;
    const braveStubReplaced = next.replace(braveStubPattern, braveLiveBlock);
    if (braveStubReplaced !== next) {
      next = braveStubReplaced;
    } else {
      const sep = next.endsWith('\n') ? '' : '\n';
      next = `${next}${sep}\n${braveLiveBlock}`;
    }
  }

  // Header-only detection (mirror of the Brave guard above): a bare
  // `[tools.web_search]` with no body would otherwise be treated as
  // "missing" and we'd append a second header — duplicate-table bug.
  const webSearchHeaderOnly = /^\[tools\.web_search\]\s*$/m;
  if (webSearchHeaderOnly.test(next) && !WEB_SEARCH_SECTION_PATTERN.test(next)) {
    next = next.replace(
      webSearchHeaderOnly,
      '[tools.web_search]\nenabled = true\n# max_results = 5'
    );
  } else if (WEB_SEARCH_SECTION_PATTERN.test(next)) {
    // Section exists: force enabled = true. Otherwise a pre-existing
    // `enabled = false` would leave web search off even though the user just
    // set a Brave key (and the caller logs "web search tool enabled").
    // Match the section block, then rewrite its `enabled = …` line in place.
    //
    // The line-match regex tolerates an optional trailing `# comment`, so a
    // line like `enabled = false  # disabled for now` rewrites cleanly. The
    // value matcher is permissive (`[^\n#]+`) so hand-edited shapes the
    // user might paste — `enabled = "false"` (string), `enabled = 0`
    // (int), `enabled = nope` — all rewrite cleanly to a single canonical
    // line. Without this, the rewrite would miss those shapes, the
    // no-line branch would fire, and we'd insert a duplicate `enabled`
    // key — producing invalid TOML (parsers reject duplicate keys).
    const enabledLine = /^enabled\s*=\s*[^\n#]+(?:#[^\n]*)?$/m;
    next = next.replace(WEB_SEARCH_SECTION_PATTERN, (block) => {
      if (/^enabled\s*=\s*true\s*(?:#[^\n]*)?$/m.test(block)) return block;
      if (enabledLine.test(block)) {
        return block.replace(enabledLine, 'enabled = true');
      }
      // No `enabled = …` line at all: insert one immediately after the header.
      return block.replace(/^(\[tools\.web_search\][^\n]*\n)/, '$1enabled = true\n');
    });
  } else {
    // No live `[tools.web_search]`. Two placements, mirrored from Brave above:
    // try the commented stub first (header + commented enabled + commented
    // max_results, as buildConfigToml emits it), fall through to EOF append.
    //
    // We deliberately PRESERVE the `# max_results = N` line as a commented
    // hint so the user can still see/uncomment the tunable. Without this,
    // stub replacement strips the line entirely and there's no visible
    // reference to max_results in the file. Capturing the original commented
    // line (rather than hard-coding `# max_results = 5`) keeps the value in
    // sync with whatever buildConfigToml emitted at init time.
    const webSearchStubPattern =
      /^# \[tools\.web_search\]\n# enabled\s*=\s*[a-zA-Z]+\n(# max_results\s*=\s*\d+\n)/m;
    const webSearchStubReplaced = next.replace(
      webSearchStubPattern,
      (_, commentedMaxResults: string) =>
        `[tools.web_search]\nenabled = true\n${commentedMaxResults}`
    );
    if (webSearchStubReplaced !== next) {
      next = webSearchStubReplaced;
    } else {
      // No stub. Append a minimal live block at EOF. max_results is
      // omitted (loader supplies the default); for parity with the stub-
      // replace path, also include the commented hint so the user has a
      // visible reference to the tunable.
      const sep = next.endsWith('\n') ? '' : '\n';
      next = `${next}${sep}\n[tools.web_search]\nenabled = true\n# max_results = 5\n`;
    }
  }

  if (next === raw) return { changed: false };
  writeFileSync(configPath, next);
  return { changed: true };
}

/**
 * Remove Brave Search and disable the web search tool by deleting both sections.
 * No-op if neither section exists.
 */
export function removeBraveSearch(configPath: string): { changed: boolean } {
  if (!existsSync(configPath)) {
    throw new Error(`config.toml not found at ${configPath}`);
  }
  const raw = readFileSync(configPath, 'utf-8');
  if (!BRAVE_SECTION_PATTERN.test(raw) && !WEB_SEARCH_SECTION_PATTERN.test(raw)) {
    return { changed: false };
  }
  let next = raw.replace(BRAVE_SECTION_PATTERN, '').replace(WEB_SEARCH_SECTION_PATTERN, '');
  next = next.replace(/\n{3,}/g, '\n\n');
  writeFileSync(configPath, next);
  return { changed: true };
}

/**
 * Replace a key (by label) in `[llm.api_keys.<provider>]` without touching the
 * tier ordering. Distinct from remove+add: the latter has to go through
 * `removeProviderFromApiKeysTier` + `addProviderToApiKeysTier` when the provider
 * has only one key, which mutates `[llm.api_keys].fallback` (and possibly
 * `primary`). This patcher rewrites the keys array in place atomically, so
 * tier order is preserved regardless of how many keys the provider has.
 *
 * Throws if the sub-section or label doesn't exist.
 */
export function replaceKeyInApiKeyProvider(
  configPath: string,
  provider: LlmProvider,
  label: string,
  newKey: string
): { changed: boolean } {
  if (!existsSync(configPath)) {
    throw new Error(`config.toml not found at ${configPath}`);
  }
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = TOML.parse(raw) as {
    llm?: { api_keys?: Record<string, unknown> };
  };
  const sub = parsed.llm?.api_keys?.[provider] as { keys?: LlmKey[] } | undefined;
  if (!sub) {
    throw new Error(`[llm.api_keys.${provider}] not found in ${configPath}`);
  }
  const existing = sub.keys ?? [];
  const target = existing.find((k) => k.label === label);
  if (!target) {
    throw new Error(`label "${label}" not found for ${provider}`);
  }
  if (target.key === newKey) return { changed: false };
  const newKeys = existing.map((k) => (k.label === label ? { key: newKey, label } : k));
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
