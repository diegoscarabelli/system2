import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compileSkillsXml,
  filterSkillsByRole,
  loadSkills,
  parseSkillFile,
  type Skill,
  scanDirectory,
} from './loader.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skills-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeSkill(dir: string, filename: string, frontmatter: Record<string, unknown>): string {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.map((i) => `"${i}"`).join(', ')}]`;
      return `${k}: "${v}"`;
    })
    .join('\n');
  const content = `---\n${fm}\n---\n\n# ${frontmatter.name ?? 'Test'}\n\nInstructions here.\n`;
  const filePath = join(dir, filename);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('parseSkillFile', () => {
  it('parses a valid skill file', () => {
    const path = writeSkill(tempDir, 'deploy.md', {
      name: 'deploy',
      description: 'Deploy to production',
      roles: ['conductor'],
    });
    const skill = parseSkillFile(path, 'user');
    expect(skill).not.toBeNull();
    expect(skill?.meta.name).toBe('deploy');
    expect(skill?.meta.description).toBe('Deploy to production');
    expect(skill?.meta.roles).toEqual(['conductor']);
    expect(skill?.source).toBe('user');
    expect(skill?.path).toBe(path);
  });

  it('returns null for missing name', () => {
    const path = writeSkill(tempDir, 'bad.md', {
      description: 'No name here',
    });
    expect(parseSkillFile(path, 'builtin')).toBeNull();
  });

  it('returns null for missing description', () => {
    const path = writeSkill(tempDir, 'bad.md', {
      name: 'no-desc',
    });
    expect(parseSkillFile(path, 'builtin')).toBeNull();
  });

  it('returns null for non-existent file', () => {
    expect(parseSkillFile(join(tempDir, 'nope.md'), 'user')).toBeNull();
  });

  it('returns null for file with no frontmatter', () => {
    const path = join(tempDir, 'plain.md');
    writeFileSync(path, '# Just markdown\n\nNo frontmatter here.\n', 'utf-8');
    expect(parseSkillFile(path, 'user')).toBeNull();
  });

  it('normalizes roles string to array', () => {
    const path = writeSkill(tempDir, 'single-role.md', {
      name: 'single',
      description: 'Single role',
      roles: 'Guide',
    });
    const skill = parseSkillFile(path, 'user');
    expect(skill?.meta.roles).toEqual(['guide']);
  });

  it('normalizes roles array to lowercase', () => {
    const path = writeSkill(tempDir, 'mixed.md', {
      name: 'mixed',
      description: 'Mixed case roles',
      roles: ['Conductor', 'REVIEWER'],
    });
    const skill = parseSkillFile(path, 'builtin');
    expect(skill?.meta.roles).toEqual(['conductor', 'reviewer']);
  });

  it('treats omitted roles as empty array (all roles)', () => {
    const path = writeSkill(tempDir, 'all.md', {
      name: 'all-roles',
      description: 'For everyone',
    });
    const skill = parseSkillFile(path, 'user');
    expect(skill?.meta.roles).toEqual([]);
  });

  it('treats empty roles array as all roles', () => {
    const path = join(tempDir, 'empty-roles.md');
    writeFileSync(path, '---\nname: empty\ndescription: Empty roles\nroles: []\n---\n\nContent\n');
    const skill = parseSkillFile(path, 'user');
    expect(skill?.meta.roles).toEqual([]);
  });

  it('normalizes name to lowercase and trims whitespace', () => {
    const path = writeSkill(tempDir, 'cased.md', {
      name: '  Deploy-Pipeline ',
      description: 'Cased name',
    });
    const skill = parseSkillFile(path, 'user');
    expect(skill?.meta.name).toBe('deploy-pipeline');
  });

  it('returns null for invalid roles type (number)', () => {
    const path = join(tempDir, 'bad-roles.md');
    writeFileSync(path, '---\nname: bad\ndescription: Bad roles\nroles: 42\n---\n\nContent\n');
    expect(parseSkillFile(path, 'user')).toBeNull();
  });

  it('returns null for roles array with only non-string entries', () => {
    const path = join(tempDir, 'bad-array.md');
    writeFileSync(
      path,
      '---\nname: bad\ndescription: Bad array\nroles:\n  - 1\n  - 2\n---\n\nContent\n'
    );
    expect(parseSkillFile(path, 'user')).toBeNull();
  });
});

describe('scanDirectory', () => {
  it('returns empty array for non-existent directory', () => {
    expect(scanDirectory(join(tempDir, 'nope'), 'user')).toEqual([]);
  });

  it('returns empty array for empty directory', () => {
    const dir = join(tempDir, 'empty');
    mkdirSync(dir);
    expect(scanDirectory(dir, 'builtin')).toEqual([]);
  });

  it('scans valid skill files', () => {
    writeSkill(tempDir, 'a.md', { name: 'alpha', description: 'Alpha skill' });
    writeSkill(tempDir, 'b.md', { name: 'beta', description: 'Beta skill' });
    const skills = scanDirectory(tempDir, 'user');
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.meta.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('skips invalid files and includes valid ones', () => {
    writeSkill(tempDir, 'good.md', { name: 'good', description: 'Good one' });
    writeFileSync(join(tempDir, 'bad.md'), '# No frontmatter\n', 'utf-8');
    const skills = scanDirectory(tempDir, 'builtin');
    expect(skills).toHaveLength(1);
    expect(skills[0].meta.name).toBe('good');
  });

  it('skips README.md', () => {
    writeFileSync(
      join(tempDir, 'README.md'),
      '---\nname: readme\ndescription: Should be skipped\n---\n'
    );
    writeSkill(tempDir, 'real.md', { name: 'real', description: 'Real skill' });
    const skills = scanDirectory(tempDir, 'builtin');
    expect(skills).toHaveLength(1);
    expect(skills[0].meta.name).toBe('real');
  });
});

describe('loadSkills', () => {
  let builtinDir: string;
  let userDir: string;

  beforeEach(() => {
    builtinDir = join(tempDir, 'builtin');
    userDir = join(tempDir, 'user');
    mkdirSync(builtinDir);
    mkdirSync(userDir);
  });

  it('merges skills from both directories', () => {
    writeSkill(builtinDir, 'a.md', { name: 'alpha', description: 'Built-in alpha' });
    writeSkill(userDir, 'b.md', { name: 'beta', description: 'User beta' });
    const skills = loadSkills(builtinDir, userDir);
    expect(skills).toHaveLength(2);
  });

  it('user skill overrides built-in with same name', () => {
    writeSkill(builtinDir, 'deploy.md', { name: 'deploy', description: 'Built-in deploy' });
    writeSkill(userDir, 'deploy.md', { name: 'deploy', description: 'User deploy' });
    const skills = loadSkills(builtinDir, userDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].meta.description).toBe('User deploy');
    expect(skills[0].source).toBe('user');
  });

  it('user skill overrides built-in regardless of name casing', () => {
    writeSkill(builtinDir, 'deploy.md', { name: 'deploy', description: 'Built-in' });
    writeSkill(userDir, 'deploy.md', { name: 'Deploy', description: 'User' });
    const skills = loadSkills(builtinDir, userDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].meta.description).toBe('User');
  });

  it('handles empty directories', () => {
    expect(loadSkills(builtinDir, userDir)).toEqual([]);
  });

  it('handles non-existent directories', () => {
    expect(loadSkills(join(tempDir, 'nope1'), join(tempDir, 'nope2'))).toEqual([]);
  });
});

describe('filterSkillsByRole', () => {
  const allRolesSkill: Skill = {
    meta: { name: 'shared', description: 'For all', roles: [] },
    path: '/fake/shared.md',
    source: 'builtin',
  };
  const conductorSkill: Skill = {
    meta: { name: 'deploy', description: 'Deploy', roles: ['conductor'] },
    path: '/fake/deploy.md',
    source: 'user',
  };
  const guideReviewerSkill: Skill = {
    meta: { name: 'review', description: 'Review', roles: ['guide', 'reviewer'] },
    path: '/fake/review.md',
    source: 'builtin',
  };

  it('includes all-role skills for any role', () => {
    const result = filterSkillsByRole([allRolesSkill], 'narrator');
    expect(result).toHaveLength(1);
  });

  it('includes role-specific skill for matching role', () => {
    const result = filterSkillsByRole([conductorSkill], 'conductor');
    expect(result).toHaveLength(1);
  });

  it('excludes role-specific skill for non-matching role', () => {
    const result = filterSkillsByRole([conductorSkill], 'guide');
    expect(result).toHaveLength(0);
  });

  it('handles mixed skills correctly', () => {
    const all = [allRolesSkill, conductorSkill, guideReviewerSkill];
    expect(filterSkillsByRole(all, 'conductor')).toHaveLength(2); // shared + deploy
    expect(filterSkillsByRole(all, 'guide')).toHaveLength(2); // shared + review
    expect(filterSkillsByRole(all, 'reviewer')).toHaveLength(2); // shared + review
    expect(filterSkillsByRole(all, 'narrator')).toHaveLength(1); // shared only
  });

  it('normalizes role comparison to lowercase', () => {
    const result = filterSkillsByRole([conductorSkill], 'Conductor');
    expect(result).toHaveLength(1);
  });
});

describe('compileSkillsXml', () => {
  it('returns empty string for no skills', () => {
    expect(compileSkillsXml([])).toBe('');
  });

  it('produces valid XML structure', () => {
    const skills: Skill[] = [
      {
        meta: { name: 'deploy', description: 'Deploy to prod', roles: [] },
        path: '/home/user/skills/deploy.md',
        source: 'user',
      },
    ];
    const xml = compileSkillsXml(skills);
    expect(xml).toContain('<available_skills>');
    expect(xml).toContain('</available_skills>');
    expect(xml).toContain('name="deploy"');
    expect(xml).toContain('description="Deploy to prod"');
  });

  it('sorts skills alphabetically by name', () => {
    const skills: Skill[] = [
      {
        meta: { name: 'zeta', description: 'Z', roles: [] },
        path: '/tmp/zeta.md',
        source: 'builtin',
      },
      {
        meta: { name: 'alpha', description: 'A', roles: [] },
        path: '/tmp/alpha.md',
        source: 'builtin',
      },
    ];
    const xml = compileSkillsXml(skills);
    const alphaIdx = xml.indexOf('name="alpha"');
    const zetaIdx = xml.indexOf('name="zeta"');
    expect(alphaIdx).toBeLessThan(zetaIdx);
  });

  it('escapes XML special characters', () => {
    const skills: Skill[] = [
      {
        meta: { name: 'test', description: 'Uses <bash> & "quotes"', roles: [] },
        path: '/tmp/test.md',
        source: 'builtin',
      },
    ];
    const xml = compileSkillsXml(skills);
    expect(xml).toContain('&lt;bash&gt;');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;quotes&quot;');
  });

  it('replaces home directory with ~ in paths', () => {
    const skills: Skill[] = [
      {
        meta: { name: 'test', description: 'Test', roles: [] },
        path: join(process.env.HOME ?? '/home/user', '.system2', 'skills', 'test.md'),
        source: 'user',
      },
    ];
    const xml = compileSkillsXml(skills);
    expect(xml).toContain('~/.system2/skills/test.md');
  });

  it('does not replace home directory when it appears mid-path', () => {
    const home = process.env.HOME ?? '/home/user';
    const skills: Skill[] = [
      {
        meta: { name: 'test', description: 'Test', roles: [] },
        path: `/other${home}/skills/test.md`,
        source: 'builtin',
      },
    ];
    const xml = compileSkillsXml(skills);
    expect(xml).not.toContain('path="~');
    expect(xml).toContain(`/other${home}/skills/test.md`);
  });
});
