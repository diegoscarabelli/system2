# Skills

Skills are reusable workflow instructions stored as `.md` files (one per skill) in the skills directories. They fill the gap between tools (single actions) and knowledge (accumulated facts) by capturing multi-step procedures that agents can follow when performing recurring tasks.

**Key source files:**
- `packages/server/src/skills/loader.ts`: skill discovery, parsing, merging, filtering, and XML compilation
- `packages/server/src/agents/host.ts`: `loadSkillsContext()` method and prompt integration
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

On every LLM call, `AgentHost.loadSkillsContext()`:

1. Scans both directories for `.md` files (flat, non-recursive)
2. Parses YAML frontmatter with `gray-matter`
3. Merges skills by name (user overrides built-in)
4. Filters to skills eligible for the current agent's role
5. Compiles a compact XML index
6. Returns the index under a `## Available Skills` heading

The XML is appended to the system prompt after the Knowledge Base section:

```xml
<available_skills>
<skill name="deploy-pipeline" path="~/.system2/skills/deploy-pipeline.md" description="Deploy a data pipeline to DiegoTower with validation" />
<skill name="code-review" path="/path/to/dist/agents/skills/code-review.md" description="Run a structured code review" />
</available_skills>
```

Agents use the `read` tool to load the full SKILL.md content when a skill is relevant to their current task. Skills are not read preemptively.

## Skill Creation by Agents

Guide and Conductor agents are instructed to proactively create skills in `~/.system2/skills/` when they recognize reusable patterns. They use the `write` tool with `commit_message` to create the file, which auto-commits to the `~/.system2` git repository.

The litmus test agents apply: "Am I writing down a fact, or a workflow I'd want to follow again?" Facts go in knowledge files; procedures become skills.

## Build Configuration

Built-in skill files are copied from `src/agents/skills/` to `dist/agents/skills/` during the tsup build (`packages/server/tsup.config.ts`). The copy is dynamic (reads the directory at build time), so adding a new built-in skill only requires placing the file in the source directory.

## See Also

- [Agents](agents.md): system prompt construction layers (includes skills index)
- [Knowledge System](knowledge-system.md): the knowledge files that coexist with skills in agent prompts
- [Tools](tools.md): the tools agents use to read and create skills (`read`, `write`)
