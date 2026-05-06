/**
 * Drift test for the schema-derived database reference content.
 *
 * The generator in `databases-reference-generator.ts` produces markdown for
 * the `editing-config-toml` agent skill and `docs/configuration.md`. This
 * test runs the generator and asserts the on-disk content matches.
 *
 * To regenerate after a schema change, run:
 *
 *   pnpm generate:db-reference
 *
 * which invokes this test with `UPDATE_SCHEMA_DERIVED=1`. In that mode the
 * test writes the produced content to disk instead of asserting equality.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyToDocsSource,
  applyToSkillSource,
  generateDatabaseReference,
} from './databases-reference-generator.js';

// `import.meta.dirname` was added in Node 20.11; the repo declares
// `engines.node >= 20`, so derive the directory from `import.meta.url`
// instead — that path works on every Node 20.x release.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const SKILL_PATH = join(
  REPO_ROOT,
  'src',
  'server',
  'agents',
  'skills',
  'editing-config-toml',
  'SKILL.md'
);
const DOCS_PATH = join(REPO_ROOT, 'docs', 'configuration.md');

const UPDATE = process.env.UPDATE_SCHEMA_DERIVED === '1';

describe('schema-derived database reference', () => {
  it('editing-config-toml/SKILL.md is in sync with the schema', () => {
    const gen = generateDatabaseReference();
    const onDisk = readFileSync(SKILL_PATH, 'utf-8');
    const expected = applyToSkillSource(onDisk, gen);
    if (UPDATE) {
      if (onDisk !== expected) writeFileSync(SKILL_PATH, expected, 'utf-8');
      return;
    }
    if (onDisk !== expected) {
      throw new Error(
        `SKILL.md is out of sync with src/shared/types/databases-schema.ts. Run \`pnpm generate:db-reference\` to update.`
      );
    }
    expect(onDisk).toBe(expected);
  });

  it('docs/configuration.md is in sync with the schema', () => {
    const gen = generateDatabaseReference();
    const onDisk = readFileSync(DOCS_PATH, 'utf-8');
    const expected = applyToDocsSource(onDisk, gen);
    if (UPDATE) {
      if (onDisk !== expected) writeFileSync(DOCS_PATH, expected, 'utf-8');
      return;
    }
    if (onDisk !== expected) {
      throw new Error(
        `docs/configuration.md is out of sync with src/shared/types/databases-schema.ts. Run \`pnpm generate:db-reference\` to update.`
      );
    }
    expect(onDisk).toBe(expected);
  });
});
