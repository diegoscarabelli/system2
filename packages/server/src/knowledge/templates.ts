/**
 * Knowledge Directory Templates
 *
 * Template content for knowledge files created during onboarding.
 * Files are only written if they don't already exist (idempotent).
 */

export const INFRASTRUCTURE_TEMPLATE = `# Infrastructure

> Data stack details. Updated by the Guide during onboarding and as infrastructure evolves.
> References to code directories, documentation, and URLs are encouraged.

## Databases


## Pipeline Orchestrator


## Git Repositories


## Other Tools

`;

export const USER_TEMPLATE = `# User Profile

> Facts about the user for personalized assistance. Updated by the Guide.

## Background


## Preferences


## Goals

`;

export function createMemoryTemplate(): string {
  const now = new Date().toISOString();
  return `---
last_narrator_update_ts: ${now}
---
# Memory

> Long-term memory of System2. Synthesized from daily logs, project narrations, and important notes.
> Periodically restructured by the Narrator for coherence.

## Notes

> Other agents write important facts here during work. The Narrator consolidates these into the document during restructuring and removes them from this section.

`;
}
