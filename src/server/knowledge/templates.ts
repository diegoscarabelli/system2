/**
 * Knowledge Directory Templates
 *
 * Template content for knowledge files created during onboarding.
 * Files are only written if they don't already exist (idempotent).
 */

export const INFRASTRUCTURE_TEMPLATE = `# Infrastructure

> Data stack details. Updated by the Guide during onboarding and as infrastructure evolves.
> References to code directories, documentation, and URLs are encouraged.

## Overview

> A few paragraphs describing the user's data stack at a high level: what they have, what
> they want, the methods and conventions they've adopted (e.g. ELT vs ETL, batch vs streaming,
> notebook-driven exploration vs production pipelines). This is the human-readable summary
> the rest of the document elaborates on.

## System

> The local machine (and any remote machines) where System2 and the data stack run.
> OS, architecture, CPU, RAM, disk, package manager, installed runtimes and tools.

## Databases

> One subsection per database. Each starts with a JSON block describing connection details,
> followed by prose covering schemas, tables of interest, retention, conventions, and quirks.
> Add JSON fields as needed (e.g. \`tunnel\`, \`read_replica\`, \`tls\`). Use \`auth\` to
> describe the mechanism (e.g. \`password\`, \`scram-sha-256\`, \`iam\`, \`peer\`), and
> \`credentials\` to point at where the secret lives on disk (e.g. \`~/.pgpass\`, \`.env\`,
> OS keychain entry name). Never paste the secret itself into this file: it is git-tracked.

> ### example_db
>
> \`\`\`json
> {
>   "engine": "postgresql",
>   "version": "16",
>   "host": "localhost",
>   "port": 5432,
>   "database": "example",
>   "auth": "scram-sha-256",
>   "credentials": "~/.pgpass",
>   "deployment": "local"
> }
> \`\`\`
>
> Prose describing what lives in this database, important schemas, retention policies,
> gotchas, and how System2 typically queries it.

## Data Repositories

> Non-database data sources: object stores, data lakes, file shares, API-accessible datasets.
> Same JSON-then-prose pattern. Add fields as the medium requires.

## Pipeline Orchestrator

> Which orchestrator (Prefect, Airflow, Dagster, cron, none), where it runs, how to access
> the UI, where flows/DAGs live, conventions for naming and structure. Prose is fine here;
> add a JSON block if connection details warrant it.

## Code Repositories

> JSON dictionary of repositories System2 should know about, keyed by short name. Add fields
> as needed (e.g. \`default_branch\`, \`package_manager\`, \`language\`).

> \`\`\`json
> {
>   "system2_data_pipelines": {
>     "local_path": "~/repos/system2_data_pipelines",
>     "remote": "git@github.com:user/system2_data_pipelines.git",
>     "purpose": "Pipeline definitions and shared data utilities"
>   }
> }
> \`\`\`
>
> Prose describing each repo's role, key directories, and conventions.

## Other Tools

> Visualization (Superset, Metabase, Grafana), notebook environments, scheduling, monitoring,
> anything else relevant to the data stack. JSON blocks where useful.

`;

export const USER_TEMPLATE = `# User Profile

> Who the user is and how they prefer to work. Updated by the Guide during onboarding
> and as new preferences or context surface. This file is injected into every agent's
> context, so keep it concise and current.

## Background

> Role, domain expertise, and technical level. This helps agents calibrate the depth
> and vocabulary of their explanations.

## Goals

> What the user wants to accomplish with System2: ongoing objectives, areas of interest,
> types of analysis or pipelines they care about.

## Communication Preferences

> How the user likes to interact: preferred level of detail, whether they want options
> presented or decisions made, tone, feedback style.

## Working Patterns

> Observable patterns: how the user iterates (small increments vs large batches),
> whether they prefer to review intermediate work or see final results.

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

export const WORKER_TEMPLATE = `# Worker Role Notes

Role-specific patterns, preferences, and accumulated knowledge shared across Worker agents.

Updated by Workers and by other agents when they have Worker-specific observations.
Always read the full file before editing. Restructure for clarity rather than appending.
Prefer shared knowledge files (infrastructure.md, user.md, memory.md) for information
useful to multiple roles. Workers are ephemeral, so keep this file lean: only reusable
patterns and lessons that benefit future workers.

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
