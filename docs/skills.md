# Skills

Skills are reusable workflow instructions stored as `.md` files (one per skill) in the skills directories. They fill the gap between tools (single actions) and knowledge (accumulated facts) by capturing multi-step procedures that agents can follow when performing recurring tasks.

**Key source files:**
- `packages/server/src/skills/loader.ts`: role-based skill filtering (`extractRoles`, `filterByRole`)
- `packages/server/src/agents/host.ts`: SDK wiring via `additionalSkillPaths` and `skillsOverride`
- `packages/server/src/agents/agents.md`: agent-facing documentation (## Skills section)
- `packages/server/src/knowledge/init.ts`: `~/.system2/skills/` directory creation

## SKILL.md Format

Each skill is a single `.md` file with YAML frontmatter:

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

### Frontmatter Fields

| Field | Required | Type | Description |
| ----- | -------- | ---- | ----------- |
| `name` | Yes | string | Lowercase, hyphenated identifier. Used for override matching. |
| `description` | Yes | string | One-line summary. Agents read this to decide relevance. |
| `roles` | No | string[] | Agent roles that can use this skill. Omit or leave empty for all roles. Values are case-insensitive. |

## Skill Directories

Skills are loaded from two directories:

| Source | Path | Precedence |
| ------ | ---- | ---------- |
| Built-in | `packages/server/src/agents/skills/` (copied to `dist/agents/skills/` at build) | Lower |
| User | `~/.system2/skills/` | Higher |

When a user skill has the same `name` as a built-in skill, the user skill takes precedence. This allows users (or agents) to override or customize built-in workflows.

The `~/.system2/skills/` directory is created automatically during server initialization. Skill files placed here are tracked by the `~/.system2` git repository once they exist (git does not track empty directories).

## Discovery and Injection

Skill discovery, frontmatter parsing, XML compilation, and prompt injection are delegated to the pi-coding-agent SDK. The server configures the SDK with two custom skill paths via `additionalSkillPaths` (user directory listed first for precedence) and a `skillsOverride` callback that filters skills by agent role.

On every LLM call, the SDK:

1. Scans both directories for `.md` files
2. Parses YAML frontmatter (name, description)
3. Merges skills by name (first path wins, so user overrides built-in)
4. Calls `skillsOverride`, where `filterByRole` removes skills not eligible for the current agent's role
5. Appends a compact XML index to the system prompt after the custom prompt sections

```xml
<available_skills>
  <skill>
    <name>deploy-pipeline</name>
    <description>Deploy a data pipeline to DiegoTower with validation</description>
    <location>~/.system2/skills/deploy-pipeline.md</location>
  </skill>
</available_skills>
```

Agents use the `read` tool to load the full skill content at the given `location` when a skill is relevant to their current task. Skills are not read preemptively.

## Skill Creation by Agents

Guide and Conductor agents are instructed to proactively create skills in `~/.system2/skills/` when they recognize reusable patterns. They use the `write` tool with `commit_message` to create the file, which auto-commits to the `~/.system2` git repository.

The litmus test agents apply: "Am I writing down a fact, or a workflow I'd want to follow again?" Facts go in knowledge files; procedures become skills.

## Build Configuration

Built-in skill files are copied from `src/agents/skills/` to `dist/agents/skills/` during the tsup build (`packages/server/tsup.config.ts`). The copy is dynamic (reads the directory at build time), so adding a new built-in skill only requires placing the file in the source directory.

## See Also

- [Agents](agents.md): system prompt construction layers (includes skills index)
- [Knowledge System](knowledge-system.md): the knowledge files that coexist with skills in agent prompts
- [Tools](tools.md): the tools agents use to read and create skills (`read`, `write`)
