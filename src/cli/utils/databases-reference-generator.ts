/**
 * Database Reference Generator
 *
 * Reads the TypeBox schemas in `src/shared/types/databases-schema.ts` and
 * emits markdown content for two consumption sites:
 *
 *   - `src/server/agents/skills/editing-config-toml/SKILL.md` — the agent
 *     skill's per-adapter field tables and credential-fallback table.
 *   - `docs/configuration.md` — the human reference's database-fields table.
 *
 * Both files have `<!-- BEGIN auto-generated:<key> -->` /
 * `<!-- END auto-generated:<key> -->` marker pairs that delimit the regions
 * the generator owns. Everything outside the markers is hand-written.
 *
 * The generator is run via `pnpm generate:db-reference` (which simply runs
 * the drift test in update mode). The same drift test, run normally, fails
 * when the on-disk content doesn't match what the generator would produce —
 * so adding a field to the schema without regenerating fails CI.
 *
 * Snowflake is a `Type.Union` of two variants (password vs key-pair auth);
 * the generator merges them and marks the auth fields as "one-of (password
 * or credentials_file required)" rather than treating either variant alone
 * as the source.
 */

import {
  ADAPTER_CREDENTIAL_FALLBACKS,
  ADAPTER_SCHEMAS,
  ADAPTER_TYPES,
  type AdapterType,
} from '../../shared/index.js';

const MARKER_BEGIN = (key: string) => `<!-- BEGIN auto-generated:${key} -->`;
const MARKER_END = (key: string) => `<!-- END auto-generated:${key} -->`;

interface FieldRow {
  name: string;
  required: 'yes' | 'no' | 'one-of';
  notes: string;
}

/** Extract the `description` annotation from a TypeBox property schema. The
 *  description may be on the schema directly or on the inner type when
 *  wrapped in `Type.Optional(...)` — the optional wrapper preserves the
 *  description on the wrapped schema. */
function fieldNotes(propSchema: unknown): string {
  // biome-ignore lint/suspicious/noExplicitAny: TypeBox runtime introspection
  const s = propSchema as any;
  if (typeof s?.description === 'string') return s.description;
  return '';
}

/**
 * Walk a TypeBox object schema and emit one row per property. Fields listed
 * in the schema's `required` array are marked yes; others are no. Notes are
 * pulled from each property's TypeBox `description` annotation.
 */
function describeObjectFields(schema: {
  properties: Record<string, unknown>;
  required?: readonly string[];
}): FieldRow[] {
  const required = new Set(schema.required ?? []);
  const rows: FieldRow[] = [];
  for (const [name, propSchema] of Object.entries(schema.properties)) {
    rows.push({
      name,
      required: required.has(name) ? 'yes' : 'no',
      notes: fieldNotes(propSchema),
    });
  }
  return rows;
}

/**
 * Snowflake schema is a `Type.Union([WithPassword, WithKeyPair])`. Merge
 * the two variants: a field is `yes` if required in BOTH, `one-of` if
 * required in EITHER (the auth fields), `no` if optional in both. Notes
 * are taken from whichever variant has a non-empty description (the two
 * variants share descriptions for shared fields).
 */
function describeSnowflakeFields(): FieldRow[] {
  const union = ADAPTER_SCHEMAS.snowflake as unknown as {
    anyOf: Array<{ properties: Record<string, unknown>; required?: readonly string[] }>;
  };
  const variants = union.anyOf;
  const allFields = new Set<string>();
  for (const v of variants) {
    for (const k of Object.keys(v.properties)) allFields.add(k);
  }
  const rows: FieldRow[] = [];
  for (const name of allFields) {
    const inAll = variants.every((v) => (v.required ?? []).includes(name));
    const inAny = variants.some((v) => (v.required ?? []).includes(name));
    let required: FieldRow['required'];
    if (inAll) required = 'yes';
    else if (inAny) required = 'one-of';
    else required = 'no';
    let notes = '';
    for (const v of variants) {
      const n = fieldNotes(v.properties[name]);
      if (n) {
        notes = n;
        break;
      }
    }
    rows.push({ name, required, notes });
  }
  return rows;
}

function describeFields(adapter: AdapterType): FieldRow[] {
  if (adapter === 'snowflake') return describeSnowflakeFields();
  // biome-ignore lint/suspicious/noExplicitAny: TypeBox runtime introspection
  const schema = ADAPTER_SCHEMAS[adapter] as any;
  return describeObjectFields(schema);
}

/**
 * Render a markdown table for a single adapter's fields. Used by both the
 * agent skill (per-adapter sub-section) and the human docs (unified table).
 */
function renderAdapterTable(adapter: AdapterType): string {
  const rows = describeFields(adapter);
  // Order: type first, then required fields (alphabetical), then one-of
  // fields (alphabetical), then optional fields (alphabetical, with
  // `database` placed first within the optional group when it isn't
  // required for that adapter — so the "what dataset/file" field stays
  // near the top even when validation doesn't require it). Required
  // fields up front so users see what they must provide before scanning
  // the optional knobs.
  const requiredRank: Record<FieldRow['required'], number> = {
    yes: 0,
    'one-of': 1,
    no: 2,
  };
  rows.sort((a, b) => {
    if (a.name === 'type') return -1;
    if (b.name === 'type') return 1;
    const rankDelta = requiredRank[a.required] - requiredRank[b.required];
    if (rankDelta !== 0) return rankDelta;
    if (a.name === 'database') return -1;
    if (b.name === 'database') return 1;
    return a.name.localeCompare(b.name);
  });
  const header = '| Field | Required | Notes |\n|-------|----------|-------|';
  const body = rows.map((r) => `| \`${r.name}\` | ${r.required} | ${r.notes || ''} |`).join('\n');
  return `${header}\n${body}`;
}

/** Render the credential-fallback table, derived from
 *  `ADAPTER_CREDENTIAL_FALLBACKS` joined with the `ADAPTER_TYPES` order. */
function renderCredentialFallbackTable(): string {
  const header =
    '| `type` | Credential fallback when `password` (or its equivalent) is omitted |\n|---|---|';
  const body = ADAPTER_TYPES.map((t) => `| \`${t}\` | ${ADAPTER_CREDENTIAL_FALLBACKS[t]} |`).join(
    '\n'
  );
  return `${header}\n${body}`;
}

/**
 * Replace the content between `<!-- BEGIN auto-generated:<key> -->` and
 * `<!-- END auto-generated:<key> -->` with the supplied replacement.
 * Throws if the markers are missing — the file should already have them.
 */
export function replaceMarkedRegion(source: string, key: string, replacement: string): string {
  const begin = MARKER_BEGIN(key);
  const end = MARKER_END(key);
  const beginIdx = source.indexOf(begin);
  const endIdx = source.indexOf(end);
  if (beginIdx === -1 || endIdx === -1 || beginIdx > endIdx) {
    throw new Error(`Markers for "${key}" not found (begin=${beginIdx}, end=${endIdx})`);
  }
  const before = source.slice(0, beginIdx + begin.length);
  const after = source.slice(endIdx);
  return `${before}\n\n${replacement}\n\n${after}`;
}

export interface GeneratedSections {
  /** One per adapter type, keyed by adapter name. */
  adapterTables: Record<AdapterType, string>;
  /** The cross-adapter credential fallback table. */
  credentialFallback: string;
}

/** Pure function: produce the generated content without touching the
 *  filesystem. The runner (and the drift test) compose these into the
 *  on-disk files via `replaceMarkedRegion`. */
export function generateDatabaseReference(): GeneratedSections {
  const adapterTables = {} as Record<AdapterType, string>;
  for (const t of ADAPTER_TYPES) {
    adapterTables[t] = renderAdapterTable(t);
  }
  return {
    adapterTables,
    credentialFallback: renderCredentialFallbackTable(),
  };
}

/**
 * Apply the generated content to a copy of the supplied skill source.
 * Returns the new content; the caller writes it to disk if changed.
 */
export function applyToSkillSource(source: string, gen: GeneratedSections): string {
  let updated = source;
  for (const t of ADAPTER_TYPES) {
    updated = replaceMarkedRegion(updated, `fields:${t}`, gen.adapterTables[t]);
  }
  updated = replaceMarkedRegion(updated, 'credential-fallback', gen.credentialFallback);
  return updated;
}

/** Apply the generated content to docs/configuration.md. The docs file uses
 *  one combined per-adapter section instead of per-adapter markers, so the
 *  generator emits the full content as one string. */
export function applyToDocsSource(source: string, gen: GeneratedSections): string {
  const combined = ADAPTER_TYPES.map((t) => `**${t}:**\n\n${gen.adapterTables[t]}`).join('\n\n');
  let updated = replaceMarkedRegion(source, 'database-fields', combined);
  updated = replaceMarkedRegion(updated, 'credential-fallback', gen.credentialFallback);
  return updated;
}
