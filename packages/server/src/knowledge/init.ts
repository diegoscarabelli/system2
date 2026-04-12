/**
 * Knowledge Directory Initialization
 *
 * Creates ~/.system2/knowledge/ with template files if they don't exist.
 * Called during server startup (idempotent).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONDUCTOR_TEMPLATE,
  createMemoryTemplate,
  GUIDE_TEMPLATE,
  INFRASTRUCTURE_TEMPLATE,
  NARRATOR_TEMPLATE,
  REVIEWER_TEMPLATE,
  USER_TEMPLATE,
  WORKER_TEMPLATE,
} from './templates.js';

/**
 * Initialize the knowledge directory with template files.
 * Only writes files that don't already exist.
 */
export function initializeKnowledge(system2Dir: string): void {
  const knowledgeDir = join(system2Dir, 'knowledge');
  const memoryDir = join(knowledgeDir, 'daily_summaries');

  // Create directories
  if (!existsSync(knowledgeDir)) {
    mkdirSync(knowledgeDir, { recursive: true });
  }
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }
  const projectsDir = join(system2Dir, 'projects');
  if (!existsSync(projectsDir)) {
    mkdirSync(projectsDir, { recursive: true });
  }
  const skillsDir = join(system2Dir, 'skills');
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
  }

  // Write template files (only if they don't exist)
  const templates: [string, string][] = [
    [join(knowledgeDir, 'infrastructure.md'), INFRASTRUCTURE_TEMPLATE],
    [join(knowledgeDir, 'user.md'), USER_TEMPLATE],
    [join(knowledgeDir, 'memory.md'), createMemoryTemplate()],
    [join(knowledgeDir, 'guide.md'), GUIDE_TEMPLATE],
    [join(knowledgeDir, 'conductor.md'), CONDUCTOR_TEMPLATE],
    [join(knowledgeDir, 'narrator.md'), NARRATOR_TEMPLATE],
    [join(knowledgeDir, 'reviewer.md'), REVIEWER_TEMPLATE],
    [join(knowledgeDir, 'worker.md'), WORKER_TEMPLATE],
  ];

  for (const [filePath, content] of templates) {
    if (!existsSync(filePath)) {
      writeFileSync(filePath, content, 'utf-8');
      console.log(`[Knowledge] Created ${filePath}`);
    }
  }
}
