/**
 * Skill Loader
 *
 * Discovers, parses, and merges SKILL.md files from built-in and user directories.
 * Compiles a compact XML index filtered by agent role for system prompt injection.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import matter from 'gray-matter';

export interface SkillMeta {
  name: string;
  description: string;
  /** Agent roles that can use this skill. Empty array = all roles. */
  roles: string[];
}

export interface Skill {
  meta: SkillMeta;
  /** Absolute path to the SKILL.md file (agents read on demand). */
  path: string;
  source: 'builtin' | 'user';
}

/**
 * Parse a single SKILL.md file. Returns null if the file is invalid or unreadable.
 */
export function parseSkillFile(filePath: string, source: 'builtin' | 'user'): Skill | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    console.warn(`[Skills] Could not read ${filePath}, skipping`);
    return null;
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch {
    console.warn(`[Skills] Invalid frontmatter in ${filePath}, skipping`);
    return null;
  }

  const { data } = parsed;

  if (!data.name || typeof data.name !== 'string') {
    console.warn(`[Skills] Missing or invalid 'name' in ${filePath}, skipping`);
    return null;
  }
  if (!data.description || typeof data.description !== 'string') {
    console.warn(`[Skills] Missing or invalid 'description' in ${filePath}, skipping`);
    return null;
  }

  // Normalize name: lowercase and trim for consistent merge key matching.
  const name = data.name.trim().toLowerCase();
  if (!name) {
    console.warn(`[Skills] Empty 'name' after normalization in ${filePath}, skipping`);
    return null;
  }

  // Normalize roles: omitted/undefined/empty = all roles (empty array).
  // String value is coerced to single-element array.
  // Mixed arrays (e.g. ["guide", 123]) silently drop non-string entries.
  // Arrays with no valid string entries reject the file.
  let roles: string[] = [];
  if (data.roles != null) {
    if (typeof data.roles === 'string') {
      roles = [data.roles.trim().toLowerCase()];
    } else if (Array.isArray(data.roles)) {
      const stringRoles = data.roles
        .filter((r): r is string => typeof r === 'string')
        .map((r) => r.trim().toLowerCase());
      if (stringRoles.length === 0 && data.roles.length > 0) {
        console.warn(`[Skills] Invalid 'roles' entries in ${filePath}, skipping`);
        return null;
      }
      roles = stringRoles;
    } else {
      console.warn(`[Skills] Invalid 'roles' type in ${filePath}, skipping`);
      return null;
    }
  }

  return {
    meta: { name, description: data.description, roles },
    path: filePath,
    source,
  };
}

/**
 * Scan a directory for .md skill files (flat, non-recursive).
 * Returns an empty array if the directory does not exist.
 */
export function scanDirectory(dirPath: string, source: 'builtin' | 'user'): Skill[] {
  if (!existsSync(dirPath)) return [];

  let files: string[];
  try {
    files = readdirSync(dirPath).filter((f) => f.endsWith('.md') && f !== 'README.md');
  } catch {
    console.warn(`[Skills] Could not read directory ${dirPath}, skipping`);
    return [];
  }
  const skills: Skill[] = [];

  for (const file of files) {
    const skill = parseSkillFile(join(dirPath, file), source);
    if (skill) skills.push(skill);
  }

  return skills;
}

/**
 * Load skills from both directories, with user skills overriding built-in by name.
 */
export function loadSkills(builtinDir: string, userDir: string): Skill[] {
  const builtinSkills = scanDirectory(builtinDir, 'builtin');
  const userSkills = scanDirectory(userDir, 'user');

  // Built-in first, then user overwrites on name collision
  const merged = new Map<string, Skill>();
  for (const skill of builtinSkills) {
    merged.set(skill.meta.name, skill);
  }
  for (const skill of userSkills) {
    merged.set(skill.meta.name, skill);
  }

  return Array.from(merged.values());
}

/**
 * Filter skills to those eligible for a given agent role.
 * Skills with an empty roles array are available to all roles.
 */
export function filterSkillsByRole(skills: Skill[], role: string): Skill[] {
  const normalizedRole = role.toLowerCase();
  return skills.filter((s) => s.meta.roles.length === 0 || s.meta.roles.includes(normalizedRole));
}

/**
 * Compile a compact XML index of skills for system prompt injection.
 * Returns an empty string if there are no skills.
 */
export function compileSkillsXml(skills: Skill[]): string {
  if (skills.length === 0) return '';

  const home = homedir();
  const sorted = [...skills].sort((a, b) => a.meta.name.localeCompare(b.meta.name));

  const entries = sorted.map((s) => {
    const displayPath = (
      s.path.startsWith(home + sep) ? `~${s.path.slice(home.length)}` : s.path
    ).replace(/\\/g, '/');
    return `<skill name="${escapeXml(s.meta.name)}" path="${escapeXml(displayPath)}" description="${escapeXml(s.meta.description)}" />`;
  });

  return `<available_skills>\n${entries.join('\n')}\n</available_skills>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
