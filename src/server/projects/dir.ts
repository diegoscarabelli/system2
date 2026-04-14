/**
 * Project Directory Resolution
 *
 * Resolves the filesystem directory for a project under ~/.system2/projects/.
 * Directories use the format {id}_{slug} where the ID is stable and the slug
 * is derived from the current project name. If the project was renamed, the
 * existing directory is renamed to match.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Resolve (and ensure) the project directory for a given project ID and name.
 *
 * - If a matching `{id}_{slug}` folder exists, returns it.
 * - If a folder with the right ID but stale slug exists, renames it and returns the new path.
 * - If multiple `{id}_*` folders exist (leftover from a prior bug), uses the most recent
 *   one and leaves the older ones untouched.
 * - If no folder exists, creates one.
 */
export function resolveProjectDir(
  projectsDir: string,
  projectId: number,
  projectName: string
): string {
  const slug = slugify(projectName);
  const canonicalName = `${projectId}_${slug}`;
  const canonicalPath = join(projectsDir, canonicalName);

  // Fast path: canonical folder already exists
  if (existsSync(canonicalPath)) {
    ensureSubdirs(canonicalPath);
    return canonicalPath;
  }

  // Scan for any existing {id}_* folders, collecting stats in one pass
  const prefix = `${projectId}_`;
  type DirEntry = { name: string; mtimeMs: number };
  const candidates: DirEntry[] = [];
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir)) {
      if (!entry.startsWith(prefix)) continue;
      const stats = statSync(join(projectsDir, entry));
      if (stats.isDirectory()) {
        candidates.push({ name: entry, mtimeMs: stats.mtimeMs });
      }
    }
  }

  if (candidates.length === 0) {
    // No existing folder: create fresh
    mkdirSync(canonicalPath, { recursive: true });
    ensureSubdirs(canonicalPath);
    return canonicalPath;
  }

  // Pick the most recently modified folder
  const target = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0].name;

  const targetPath = join(projectsDir, target);

  // Rename to match current project name
  renameSync(targetPath, canonicalPath);

  // Patch stale project_name in log.md frontmatter
  const logFile = join(canonicalPath, 'log.md');
  if (existsSync(logFile)) {
    const content = readFileSync(logFile, 'utf-8');
    const updated = content.replace(/^project_name: .+$/m, () => `project_name: ${projectName}`);
    if (updated !== content) {
      writeFileSync(logFile, updated, 'utf-8');
    }
  }

  ensureSubdirs(canonicalPath);
  return canonicalPath;
}

function ensureSubdirs(projectDir: string): void {
  for (const sub of ['artifacts', 'scratchpad']) {
    mkdirSync(join(projectDir, sub), { recursive: true });
  }
}
