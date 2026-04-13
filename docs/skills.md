# Skills

Skills are reusable workflow instructions following the [Agent Skills standard](https://agentskills.io/specification). Each skill is a subdirectory containing a `SKILL.md` file. They fill the gap between tools (single actions) and knowledge (accumulated facts) by capturing multi-step procedures that agents can follow when performing recurring tasks.

**Key source files:**
- `packages/server/src/skills/loader.ts`: role-based skill filtering (`extractRoles`, `filterByRole`)
- `packages/server/src/agents/host.ts`: SDK wiring via `additionalSkillPaths` and `skillsOverride`
- `packages/server/src/agents/agents.md`: agent-facing documentation (## Skills section)
- `packages/server/src/knowledge/init.ts`: `~/.system2/skills/` directory creation

## Skill Structure

Each skill is a subdirectory named after the skill, containing a `SKILL.md` file:

```text
skills/
  deploy-pipeline/
    SKILL.md              # Required: frontmatter + instructions
    scripts/              # Optional: helper scripts
    references/           # Optional: reference docs
```

### SKILL.md Format

`SKILL.md` uses YAML frontmatter followed by the skill instructions:

```yaml
---
name: deploy-pipeline
description: Deploy a data pipeline to DiegoTower with validation
roles: [conductor]
---

# Deploy Pipeline

1. SSH into DiegoTower...
2. Run validation checks...
3. ...
```

The `name` field must match the parent directory name (e.g., `deploy-pipeline/SKILL.md` must have `name: deploy-pipeline`).

### Frontmatter Fields

| Field | Required | Type | Description |
| ----- | -------- | ---- | ----------- |
| `name` | Yes | string | Lowercase, hyphenated identifier. Must match parent directory name. |
| `description` | Yes | string | One-line summary. Agents read this to decide relevance. |
| `roles` | No | string[] | Agent roles that can use this skill. Omit or leave empty for all roles. Values are case-insensitive. |

## Skill Directories

Skills are loaded from two directories:

| Source | Path | Precedence |
| ------ | ---- | ---------- |
| Built-in | `packages/server/src/agents/skills/` (copied to `dist/agents/skills/` at build) | Lower |
| User | `~/.system2/skills/` | Higher |

When a user skill has the same `name` as a built-in skill, the user skill takes precedence. This allows users (or agents) to override or customize built-in workflows.

The `~/.system2/skills/` directory is created automatically during server initialization. Skill subdirectories placed here are tracked by the `~/.system2` git repository.

## Discovery and Injection

Skill discovery, frontmatter parsing, XML compilation, and prompt injection are delegated to the pi-coding-agent SDK. The server configures the SDK with two custom skill paths via `additionalSkillPaths` (user directory listed first for precedence) and a `skillsOverride` callback that filters skills by agent role.

On every LLM call, the SDK:

1. Scans both directories for subdirectories containing `SKILL.md`
2. Parses YAML frontmatter (name, description)
3. Merges skills by name (first path wins, so user overrides built-in)
4. Calls `skillsOverride`, where `filterByRole` removes skills not eligible for the current agent's role
5. Appends a compact XML index to the system prompt after the custom prompt sections

```xml
<available_skills>
  <skill>
    <name>deploy-pipeline</name>
    <description>Deploy a data pipeline to DiegoTower with validation</description>
    <location>~/.system2/skills/deploy-pipeline/SKILL.md</location>
  </skill>
</available_skills>
```

Agents use the `read` tool to load the full skill content at the given `location` when a skill is relevant to their current task. Skills are not read preemptively.

## Skill Creation by Agents

Guide and Conductor agents are instructed to proactively create skills in `~/.system2/skills/` when they recognize reusable patterns. They create a subdirectory named after the skill and write a `SKILL.md` file inside it, using the `write` tool with `commit_message` to auto-commit to the `~/.system2` git repository.

The litmus test agents apply: "Am I writing down a fact, or a workflow I'd want to follow again?" Facts go in knowledge files; procedures become skills.

## Built-in Skills

Built-in skills live in `packages/server/src/agents/skills/`:

| Skill | Description |
| ----- | ----------- |
| `system2-onboarding` | First-launch setup: greets the user, learns about them, detects the system, configures the data stack (including external database connections and driver installation), sets up the development environment, and captures interaction preferences. Triggered when `infrastructure.md` is still the unedited template, or when the user explicitly asks to re-onboard. |
| `project-creation` | Delegating complex work to a new project: gathers preliminary requirements with the user, creates the project in app.db, spawns a Conductor and Reviewer, introduces them to each other, and schedules a follow-up reminder so a silent Conductor is noticed. |
| `project-completion` | Finalizing a completed project: confirms with the user, tells the Conductor to close the project, waits for the close-project report (including the Narrator's project story), then terminates the Conductor and Reviewer and marks the project done. |
| `project-restart` | Revisiting a completed project: helps the user weigh resurrection against a new project, then resurrects the original Conductor and Reviewer with their context intact and reopens the project record. |
| `ui-reference` | UI layout and panel reference: describes the sidebar, artifact viewer, chat panel, agent pane, cron jobs panel, and kanban board so the Guide can give accurate directions when the user asks about the interface. |
| `db-schema-reference` | Column-level schema details for all seven app.db tables: column names, types, constraints, and indexes for writing queries or managing records. Available to all roles. |
| `airflow` | Apache Airflow v3 workflow orchestration: DAG design, TaskFlow API, dynamic task mapping, connections/secrets, scheduling, error handling, debugging, and production checklist. |
| `prefect` | Prefect v3 data pipelines: flows, tasks, deployments, work pools, concurrency, error handling, testing, events/automations, and production checklist. |
| `timescaledb` | TimescaleDB time-series database: hypertables, chunk sizing, compression (segmentby/orderby), continuous aggregates, retention policies, ingestion performance, and monitoring. |
| `sql-schema-modeling` | SQL schema design: normalization (1NF-BCNF), dimensional modeling (star schema, SCD types), JSON/JSONB columns with indexing, primary key strategy, indexing patterns, naming conventions, and anti-patterns (EAV, polymorphic associations). |
| `statistical-analysis` | Statistical methodology: frequentist and Bayesian workflows, test selection, assumption checking, effect sizes, multiple comparisons, power analysis, missing data handling, bootstrap methods, time series analysis, meta-analysis, reporting standards, and common anti-patterns. |

## Build Configuration

Built-in skill subdirectories are copied from `src/agents/skills/` to `dist/agents/skills/` during the tsup build (`packages/server/tsup.config.ts`). The copy is dynamic (reads the directory at build time), so adding a new built-in skill only requires creating a `skill-name/SKILL.md` subdirectory in the source directory.

## See Also

- [Agents](agents.md): system prompt construction layers (includes skills index)
- [Knowledge System](knowledge-system.md): the knowledge files that coexist with skills in agent prompts
- [Tools](tools.md): the tools agents use to read and create skills (`read`, `write`)
