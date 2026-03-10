# Knowledge System

System2 maintains persistent knowledge in `~/.system2/knowledge/`, git-tracked for change history. Knowledge files are injected into agent system prompts dynamically -- re-read on every LLM API call for immediate effect.

**Key source files:**
- `packages/server/src/knowledge/init.ts` -- directory initialization
- `packages/server/src/knowledge/templates.ts` -- default file templates
- `packages/server/src/knowledge/git.ts` -- git repo setup
- `packages/server/src/agents/host.ts` -- `loadKnowledgeContext()` method

## Knowledge Directory

```
~/.system2/knowledge/
├── infrastructure.md      # Data stack details (databases, orchestrator, repos)
├── user.md                # User profile and preferences
├── memory.md              # Long-term memory with YAML frontmatter
└── daily_summaries/       # Daily activity summaries
    ├── 2024-01-15.md
    ├── 2024-01-16.md
    └── ...
```

Project-scoped files live outside `knowledge/`:

```
~/.system2/projects/
└── {project_id}/
    ├── log.md             # Continuous project log (Narrator, append-only)
    └── project_story.md   # Final narrative (Narrator, on completion)
```

## File Ownership

| File | Written By | Updated When |
|------|-----------|-------------|
| `infrastructure.md` | Guide | During onboarding and as infrastructure evolves |
| `user.md` | Guide | During onboarding and ongoing interactions |
| `memory.md` | Narrator | Daily at 4 AM (memory-update job) |
| `memory.md ## Notes` | Any agent | Anytime -- agents write important facts here |
| `daily_summaries/*.md` | Narrator | Every 30 minutes (configurable) |
| `projects/{id}/log.md` | Narrator | Every 30 minutes (same cron as daily summary) |
| `projects/{id}/project_story.md` | Narrator | Once, when Conductor assigns story task at project completion |

## How Knowledge Enters System Prompts

`AgentHost.loadKnowledgeContext()` runs on every LLM call (via `systemPromptOverride` callback):

1. Reads `infrastructure.md`, `user.md`, `memory.md`
2. Skips files with 10 or fewer lines (empty templates)
3. Loads role-aware context based on the agent's project assignment:
   - **Project-scoped agents** (Conductor, Reviewer, specialists): loads `projects/{project_id}/log.md`
   - **System-wide agents** (Guide, Narrator): loads the 2 most recent daily summary files (sorted by filename, chronological order)
4. Returns all content under a `## Knowledge Base` header, separated by `---`

This is appended to the static system prompt (agents.md + role instructions).

## memory.md

Long-term memory maintained by the Narrator. Has YAML frontmatter tracking timestamps:

```markdown
---
last_narrator_update_ts: 2024-01-16T04:00:00.000Z
---
# Memory

Consolidated knowledge about the system, user, and project history.

## Notes

Agents write important facts here for the Narrator to incorporate.
```

The **## Notes** section is a scratchpad -- any agent can append notes. During the daily memory-update job (4 AM), the Narrator reads all recent daily summaries, incorporates new information into the memory document, and clears processed notes.

## Project Logs

A single continuous file per project (`projects/{id}/log.md`), created when the project starts (conductor is spawned) and appended to until the project is done. Unlike daily summaries, project logs do not rotate by date.

```markdown
---
last_narrator_update_ts: 2024-01-16T15:30:00.000Z
---
# Project Log — LinkedIn Campaign Analysis

## 2024-01-16 14:00

Conductor planned 7 tasks across 4 phases...

## 2024-01-16 14:30

DataAgent-Extract completed task #10...
```

The scheduler delivers project-log messages to the Narrator on the same cron schedule as daily summaries (Phase 1 of the pipeline). The Narrator synthesizes activity from all agents involved in the project (project-scoped agents + Guide + Narrator) and project-scoped database changes.

Project-scoped agents receive this file in their system prompt instead of daily summaries.

## Daily Summaries

Append-only files named `YYYY-MM-DD.md` with YAML frontmatter, one per day:

```markdown
---
last_narrator_update_ts: 2024-01-16T15:30:00.000Z
---
# Daily Summary — 2024-01-16

## 14:00

### Project: LinkedIn Campaign Analysis
Conductor planned 7 tasks...

### Non-Project
Guide answered user question about TimescaleDB configuration...
```

The scheduler pre-computes activity data grouped into project sections (project-scoped agent JSONL + project DB changes) and a non-project section (Guide + Narrator JSONL + non-project DB changes). The Narrator synthesizes each section, avoiding repetition of content already covered in project-log entries. See [Scheduler](scheduler.md) for the pipeline details.

System-wide agents (Guide, Narrator) receive the two most recent daily summaries in their system prompt.

## Project Stories

Written once per project at completion. The Conductor creates a "Write project story" task assigned to the Narrator as the last project task. The Narrator reconstructs the project journalistically by reading the project log, session JSONL files, and app.db records, then writes the story to `projects/{id}/project_story.md`.

See [Scheduler](scheduler.md) for the pipeline that produces project logs and daily summaries.

## Git Tracking

`~/.system2/` is a git repository initialized at first server start (`knowledge/git.ts`). Knowledge and project files are version-tracked; binary and runtime files are gitignored.

**How commits happen:** The `write` and `edit` tools accept an optional `commit_message` parameter. When provided and the target path is inside `~/.system2/`, the tool auto-commits the file after the operation. Agents provide descriptive messages (e.g., `"daily summary: 2024-01-16 14:30"`). If an agent modifies a tracked file via `bash` instead, it must commit manually.

**Gitignored:** `app.db` (and WAL/SHM), `sessions/`, `logs/`, `*.log`, `server.pid`, `config.toml` (contains API keys), `chat-history.json` (UI state).

**Backup:** The CLI creates timestamped full copies (`~/.system2-auto-backup-*`) on every `system2 start` (24h cooldown, 5 max retention). This covers everything git ignores (database, sessions, config). See [CLI](packages/cli.md) and [Configuration](configuration.md).

## Initialization

`initializeKnowledge()` creates the knowledge directory structure and writes template files if they don't exist. This is idempotent -- called on every server start.

## See Also

- [Agents](agents.md) -- system prompt construction using knowledge
- [Scheduler](scheduler.md) -- jobs that trigger Narrator updates
- [Configuration](configuration.md) -- `daily_summary_interval_minutes` setting
