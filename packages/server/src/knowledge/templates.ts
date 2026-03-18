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

export const GUIDE_TEMPLATE = `# Guide Role Notes

Role-specific patterns, preferences, and accumulated knowledge for the Guide agent.

Updated by the Guide and by other agents when they have Guide-specific observations.
Always read the full file before editing. Restructure for clarity rather than appending.
Prefer shared knowledge files (infrastructure.md, user.md, memory.md) for information
useful to multiple roles.

## Patterns

## Observations
`;

export const CONDUCTOR_TEMPLATE = `# Conductor Role Notes

Role-specific patterns, preferences, and accumulated knowledge for the Conductor agent.

Updated by the Conductor and by other agents when they have Conductor-specific observations.
Always read the full file before editing. Restructure for clarity rather than appending.
Prefer shared knowledge files (infrastructure.md, user.md, memory.md) for information
useful to multiple roles.

## Patterns

## Observations
`;

export const NARRATOR_TEMPLATE = `# Narrator Role Notes

Role-specific patterns, preferences, and accumulated knowledge for the Narrator agent.

Updated by the Narrator and by other agents when they have Narrator-specific observations.
Always read the full file before editing. Restructure for clarity rather than appending.
Prefer shared knowledge files (infrastructure.md, user.md, memory.md) for information
useful to multiple roles.

## Patterns

## Observations
`;

export const REVIEWER_TEMPLATE = `# Reviewer Role Notes

Role-specific patterns, preferences, and accumulated knowledge for the Reviewer agent.

Updated by the Reviewer and by other agents when they have Reviewer-specific observations.
Always read the full file before editing. Restructure for clarity rather than appending.
Prefer shared knowledge files (infrastructure.md, user.md, memory.md) for information
useful to multiple roles.

## Patterns

## Observations
`;

export function createMemoryTemplate(): string {
  const now = new Date().toISOString();
  return `---
last_narrator_update_ts: ${now}
---
# Memory

> Long-term memory of System2. Synthesized from daily logs, project narrations, and important notes.
> Periodically restructured by the Narrator for coherence.

## Latest Learnings

> Other agents write important facts here during work. The Narrator consolidates these into the document during restructuring and removes them from this section.

`;
}
