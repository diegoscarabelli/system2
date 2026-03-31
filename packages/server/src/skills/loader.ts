/**
 * Skill Role Filter
 *
 * Extracts the `roles` frontmatter field from skill files and filters
 * SDK-discovered skills by agent role. Discovery, parsing, XML compilation,
 * and prompt injection are handled by the pi-coding-agent SDK.
 */

import { readFileSync } from 'node:fs';
import type { Skill } from '@mariozechner/pi-coding-agent';
import matter from 'gray-matter';

/**
 * Extract the normalized `roles` array from a skill file's YAML frontmatter.
 * Returns an empty array (meaning "all roles") if:
 * - The file is unreadable or has no/invalid frontmatter
 * - The `roles` field is omitted or an empty array
 *
 * Returns null if `roles` is present but entirely invalid (e.g. a number,
 * or an array with no valid string entries), signalling the skill should
 * be excluded.
 */
export function extractRoles(filePath: string): string[] | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch {
    return [];
  }

  const { roles } = parsed.data;

  if (roles == null) return [];

  if (typeof roles === 'string') {
    const trimmed = roles.trim().toLowerCase();
    return trimmed ? [trimmed] : null;
  }

  if (Array.isArray(roles)) {
    const valid = roles
      .filter((r): r is string => typeof r === 'string')
      .map((r) => r.trim().toLowerCase())
      .filter((r) => r !== '');
    if (valid.length === 0 && roles.length > 0) return null;
    return valid;
  }

  // Invalid type (number, boolean, object, etc.)
  return null;
}

/**
 * Filter SDK Skill objects to those eligible for a given agent role.
 * Skills whose frontmatter has no `roles` (or empty roles) are available to all roles.
 * Skills with invalid `roles` metadata are excluded.
 */
export function filterByRole(skills: Skill[], role: string): Skill[] {
  if (!role) return skills;
  const normalizedRole = role.toLowerCase();
  return skills.filter((skill) => {
    const roles = extractRoles(skill.filePath);
    if (roles === null) return false;
    return roles.length === 0 || roles.includes(normalizedRole);
  });
}
