import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Skill } from '@mariozechner/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractRoles, filterByRole } from './loader.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skills-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeSkillFile(dir: string, filename: string, content: string): string {
  const filePath = join(dir, filename);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function makeSdkSkill(overrides: Partial<Skill> & { filePath: string }): Skill {
  return {
    name: 'test',
    description: 'Test skill',
    baseDir: '/fake',
    sourceInfo: { type: 'path' },
    disableModelInvocation: false,
    ...overrides,
  } as Skill;
}

describe('extractRoles', () => {
  it('returns roles array from valid frontmatter', () => {
    const path = writeSkillFile(
      tempDir,
      'deploy.md',
      '---\nname: deploy\ndescription: Deploy\nroles: [conductor]\n---\n\nContent\n'
    );
    expect(extractRoles(path)).toEqual(['conductor']);
  });

  it('normalizes roles to lowercase', () => {
    const path = writeSkillFile(
      tempDir,
      'test.md',
      '---\nname: test\ndescription: Test\nroles: [Conductor, REVIEWER]\n---\n\nContent\n'
    );
    expect(extractRoles(path)).toEqual(['conductor', 'reviewer']);
  });

  it('coerces string roles to single-element array', () => {
    const path = writeSkillFile(
      tempDir,
      'test.md',
      '---\nname: test\ndescription: Test\nroles: Guide\n---\n\nContent\n'
    );
    expect(extractRoles(path)).toEqual(['guide']);
  });

  it('trims whitespace from roles string', () => {
    const path = writeSkillFile(
      tempDir,
      'test.md',
      '---\nname: test\ndescription: Test\nroles: " conductor "\n---\n\nContent\n'
    );
    expect(extractRoles(path)).toEqual(['conductor']);
  });

  it('trims whitespace from roles array entries', () => {
    const path = writeSkillFile(
      tempDir,
      'test.md',
      '---\nname: test\ndescription: Test\nroles:\n  - " guide "\n  - " reviewer "\n---\n\nContent\n'
    );
    expect(extractRoles(path)).toEqual(['guide', 'reviewer']);
  });

  it('returns empty array when roles is omitted', () => {
    const path = writeSkillFile(
      tempDir,
      'test.md',
      '---\nname: test\ndescription: Test\n---\n\nContent\n'
    );
    expect(extractRoles(path)).toEqual([]);
  });

  it('returns empty array for empty roles array', () => {
    const path = writeSkillFile(
      tempDir,
      'test.md',
      '---\nname: test\ndescription: Test\nroles: []\n---\n\nContent\n'
    );
    expect(extractRoles(path)).toEqual([]);
  });

  it('returns null for whitespace-only roles string', () => {
    const path = writeSkillFile(
      tempDir,
      'test.md',
      '---\nname: test\ndescription: Test\nroles: "   "\n---\n\nContent\n'
    );
    expect(extractRoles(path)).toBeNull();
  });

  it('returns null for invalid roles type (number)', () => {
    const path = writeSkillFile(
      tempDir,
      'test.md',
      '---\nname: test\ndescription: Test\nroles: 42\n---\n\nContent\n'
    );
    expect(extractRoles(path)).toBeNull();
  });

  it('returns null for array with only non-string entries', () => {
    const path = writeSkillFile(
      tempDir,
      'test.md',
      '---\nname: test\ndescription: Test\nroles:\n  - 1\n  - 2\n---\n\nContent\n'
    );
    expect(extractRoles(path)).toBeNull();
  });

  it('filters out empty-string entries from mixed array', () => {
    const path = writeSkillFile(
      tempDir,
      'test.md',
      '---\nname: test\ndescription: Test\nroles:\n  - "guide"\n  - "   "\n---\n\nContent\n'
    );
    expect(extractRoles(path)).toEqual(['guide']);
  });

  it('silently drops non-string entries from mixed array', () => {
    const path = writeSkillFile(
      tempDir,
      'test.md',
      '---\nname: test\ndescription: Test\nroles:\n  - guide\n  - 123\n---\n\nContent\n'
    );
    expect(extractRoles(path)).toEqual(['guide']);
  });

  it('returns empty array for non-existent file', () => {
    expect(extractRoles(join(tempDir, 'nope.md'))).toEqual([]);
  });

  it('returns empty array for file with no frontmatter', () => {
    const path = writeSkillFile(tempDir, 'plain.md', '# Just markdown\n\nNo frontmatter.\n');
    expect(extractRoles(path)).toEqual([]);
  });
});

describe('filterByRole', () => {
  function skillAt(filePath: string): Skill {
    return makeSdkSkill({ filePath });
  }

  it('includes skills with no roles restriction (all roles)', () => {
    const path = writeSkillFile(
      tempDir,
      'all.md',
      '---\nname: all\ndescription: For all\n---\n\nContent\n'
    );
    const result = filterByRole([skillAt(path)], 'narrator');
    expect(result).toHaveLength(1);
  });

  it('includes skills matching the agent role', () => {
    const path = writeSkillFile(
      tempDir,
      'deploy.md',
      '---\nname: deploy\ndescription: Deploy\nroles: [conductor]\n---\n\nContent\n'
    );
    const result = filterByRole([skillAt(path)], 'conductor');
    expect(result).toHaveLength(1);
  });

  it('excludes skills not matching the agent role', () => {
    const path = writeSkillFile(
      tempDir,
      'deploy.md',
      '---\nname: deploy\ndescription: Deploy\nroles: [conductor]\n---\n\nContent\n'
    );
    const result = filterByRole([skillAt(path)], 'guide');
    expect(result).toHaveLength(0);
  });

  it('excludes skills with invalid roles metadata', () => {
    const path = writeSkillFile(
      tempDir,
      'bad.md',
      '---\nname: bad\ndescription: Bad\nroles: 42\n---\n\nContent\n'
    );
    const result = filterByRole([skillAt(path)], 'conductor');
    expect(result).toHaveLength(0);
  });

  it('normalizes role comparison to lowercase', () => {
    const path = writeSkillFile(
      tempDir,
      'deploy.md',
      '---\nname: deploy\ndescription: Deploy\nroles: [conductor]\n---\n\nContent\n'
    );
    const result = filterByRole([skillAt(path)], 'Conductor');
    expect(result).toHaveLength(1);
  });

  it('handles mixed skills correctly', () => {
    const allPath = writeSkillFile(
      tempDir,
      'all.md',
      '---\nname: all\ndescription: For all\n---\n\nContent\n'
    );
    const conductorPath = writeSkillFile(
      tempDir,
      'deploy.md',
      '---\nname: deploy\ndescription: Deploy\nroles: [conductor]\n---\n\nContent\n'
    );
    const guidePath = writeSkillFile(
      tempDir,
      'review.md',
      '---\nname: review\ndescription: Review\nroles: [guide, reviewer]\n---\n\nContent\n'
    );
    const all = [skillAt(allPath), skillAt(conductorPath), skillAt(guidePath)];
    expect(filterByRole(all, 'conductor')).toHaveLength(2); // all + deploy
    expect(filterByRole(all, 'guide')).toHaveLength(2); // all + review
    expect(filterByRole(all, 'narrator')).toHaveLength(1); // all only
  });

  it('returns all skills when role is empty', () => {
    const path = writeSkillFile(
      tempDir,
      'deploy.md',
      '---\nname: deploy\ndescription: Deploy\nroles: [conductor]\n---\n\nContent\n'
    );
    const result = filterByRole([skillAt(path)], '');
    expect(result).toHaveLength(1);
  });
});
