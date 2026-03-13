# Knowledge System

System2 maintains persistent knowledge in `~/.system2/knowledge/`, git-tracked for change history. Knowledge files are injected into agent system prompts dynamically, re-read on every LLM API call for immediate effect.

**Key source files:**
- `packages/server/src/knowledge/init.ts`: directory initialization
- `packages/server/src/knowledge/templates.ts`: default file templates
- `packages/server/src/knowledge/git.ts`: git repo setup
- `packages/server/src/agents/host.ts`: `loadKnowledgeContext()` method

## Knowledge Directory

```
~/.system2/knowledge/
├── infrastructure.md      # Data stack details (databases, orchestrator, repos)
├── user.md                # User profile and preferences
├── memory.md              # Long-term memory with YAML frontmatter
├── guide.md               # Guide role-specific accumulated knowledge
├── conductor.md           # Conductor role-specific accumulated knowledge
├── narrator.md            # Narrator role-specific accumulated knowledge
├── reviewer.md            # Reviewer role-specific accumulated knowledge
└── daily_summaries/       # Daily activity summaries
    ├── 2024-01-15.md
    ├── 2024-01-16.md
    └── ...
```

### Role-Specific Knowledge Files

Each agent role has its own knowledge file at `~/.system2/knowledge/{role}.md`
(guide.md, conductor.md, narrator.md, reviewer.md). These are injected into each
agent's context immediately after the shared files and before the activity context
(project log or daily summaries).

These files are **separate from and in addition to** the built-in system instructions
each role receives (the static role prompts in `packages/server/src/agents/library/`).
The static prompts define how an agent behaves; the role knowledge files accumulate
what an agent has *learned* — patterns, preferences, and lessons that build up over
time. They provide a path for self-improvement and customization without modifying
the codebase: agents refine their own behavior by updating these files as they work.

**Curation rules:**

- The primary curator is any agent of that role, but any agent may contribute role-specific observations.
- Always read the full file before updating. Restructure for clarity; do not just append.
- Prefer the shared files when information is relevant to multiple roles.
- Empty files are skipped.

Project-scoped files live outside `knowledge/`:

```
~/.system2/projects/
└── {id}_{name}/           # e.g. 1_linkedin-campaign (Conductor creates)
    ├── log.md             # Continuous project log (Narrator, append-only)
    ├── project_story.md   # Final narrative (Narrator, on completion)
    └── artifacts/         # Reports, dashboards, data exports
```

## File Ownership

| File | Written By | Updated When |
|------|-----------|-------------|
| `infrastructure.md` | Guide | During onboarding and as infrastructure evolves |
| `user.md` | Guide | During onboarding and ongoing interactions |
| `memory.md` | Narrator | Daily at 11 AM (memory-update job) |
| `memory.md ## Notes` | Any agent | Anytime: agents write important facts here |
| `{role}.md` | Agent of that role (any agent may contribute) | As role-specific lessons and patterns accumulate |
| `daily_summaries/*.md` | Narrator | Every 30 minutes (configurable) |
| `projects/{id}_{name}/log.md` | Narrator | Every 30 minutes (same cron as daily summary) |
| `projects/{id}_{name}/project_story.md` | Narrator | Once, when Conductor calls `trigger_project_story` at project completion |

## How Knowledge Enters System Prompts

`AgentHost.loadKnowledgeContext()` runs on every LLM call (via `resourceLoader.reload()` called before each prompt, which invokes the `systemPromptOverride` callback):

1. Reads `infrastructure.md`, `user.md`, `memory.md`
2. Reads `{role}.md` for the agent's role (guide.md, conductor.md, narrator.md, reviewer.md)
3. Skips empty files
4. Loads role-aware context based on the agent's project assignment:
   - **Project-scoped agents** (Conductor, Reviewer, specialists): loads `projects/{id}_{name}/log.md`
   - **System-wide agents** (Guide, Narrator): loads the 2 most recent daily summary files (sorted by filename, chronological order)
5. Returns all content under a `## Knowledge Base` header, separated by `---`

Each section is prefixed with a `### ~/.system2/...` heading so agents can identify the source of each piece of context. The block ends with `---\n\nConversation history follows.` to mark the boundary between instructions and the messages array.

### Examples

**Guide** (system-wide agent):

```text
SYSTEM PROMPT (rebuilt on every LLM call):
  1. agents.md: shared reference (static)
  2. library/guide.md: Guide role instructions (static)
  3. ## Knowledge Base (dynamic, re-read every call)
       ### ~/.system2/knowledge/infrastructure.md
       [content]
       ---
       ### ~/.system2/knowledge/user.md
       [content]
       ---
       ### ~/.system2/knowledge/memory.md
       [content]
       ---
       ### ~/.system2/knowledge/guide.md
       [content]
       ---
       ### ~/.system2/knowledge/daily_summaries/2026-03-10.md
       [content]
       ---
       ### ~/.system2/knowledge/daily_summaries/2026-03-11.md
       [content]
       ---
       Conversation history follows.

MESSAGES (from JSONL session, ~/.system2/sessions/guide_1/):
  [turn 1] user: ...
  [turn 1] assistant: ...
  [turn 2] user: ...
  [turn 2] assistant: ...
  ... (or a compaction summary if context was compressed)

CURRENT TURN:
  [user message / scheduled trigger / inbound agent message]
```

**Conductor** (project-scoped, project `1_linkedin-campaign`):

```text
SYSTEM PROMPT (rebuilt on every LLM call):
  1. agents.md: shared reference (static)
  2. library/conductor.md: Conductor role instructions (static)
  3. ## Knowledge Base (dynamic, re-read every call)
       ### ~/.system2/knowledge/infrastructure.md
       [content]
       ---
       ### ~/.system2/knowledge/user.md
       [content]
       ---
       ### ~/.system2/knowledge/memory.md
       [content]
       ---
       ### ~/.system2/knowledge/conductor.md
       [content]
       ---
       ### ~/.system2/projects/1_linkedin-campaign/log.md
       [content]
       ---
       Conversation history follows.

MESSAGES (from JSONL session, ~/.system2/sessions/conductor_3/):
  [turn 1] user: [Message from guide agent (id=1)] Here is your project...
  [turn 1] assistant: ...
  ... (or a compaction summary if context was compressed)

CURRENT TURN:
  [inbound agent message / task assignment]
```

Empty files are skipped. If no knowledge files have content, the `## Knowledge Base` block is omitted but `Conversation history follows.` is still appended. The `user` role in agent JSONL is used for all inbound messages: from the user, other agents, or the scheduler.

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

The **## Notes** section is a scratchpad: any agent can append notes. During the daily memory-update job (11 AM), the Narrator reads all recent daily summaries, incorporates new information into the memory document, and clears processed notes.

## Project Logs

A single continuous file per project (`projects/{id}_{name}/log.md`), created when the project starts (Conductor is spawned) and appended to until the project is done. Unlike daily summaries, project logs do not rotate by date.

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

The scheduler delivers project-log messages to the Narrator on the same cron schedule as daily summaries (Phase 1 of the pipeline). The Narrator synthesizes activity from all agents involved in the project (project-scoped agents + Guide; Narrator is excluded to prevent recursive embedding) and project-scoped database changes.

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

The scheduler pre-computes activity data grouped into project sections (project-scoped agent JSONL + project DB changes) and a non-project section (Guide JSONL + non-project DB changes; the Narrator is excluded to prevent recursive embedding of its own injections). The Narrator synthesizes each section, avoiding repetition of content already covered in project-log entries. See [Scheduler](scheduler.md) for the pipeline details.

System-wide agents (Guide, Narrator) receive the two most recent daily summaries in their system prompt.

## Project Stories

Written once per project at completion. The Conductor calls `trigger_project_story` during its close-project routine, which creates a story task and delivers two messages to the Narrator via FIFO queue:

1. A final project-log update (same format as scheduled project-log messages)
2. A project story data package (full `app.db` snapshot + `log.md` content)

The Narrator processes Message 1 first (appends a final log entry), then Message 2 (writes the story to `projects/{id}_{name}/project_story.md`). The server pre-computes all data so the Narrator does not need to query for it. When done, the Narrator messages the Conductor, and the Conductor reports back to the Guide.

See [Scheduler](scheduler.md) for the pipeline that produces project logs and daily summaries.

## Git Tracking

`~/.system2/` is a git repository initialized at first server start (`knowledge/git.ts`). Knowledge and project files are version-tracked; binary and runtime files are gitignored.

**How commits happen:** The `write` and `edit` tools accept an optional `commit_message` parameter. When provided and the target path is inside `~/.system2/`, the tool auto-commits the file after the operation. Agents provide descriptive messages (e.g., `"daily summary: 2024-01-16 14:30"`). If an agent modifies a tracked file via `bash` instead, it must commit manually.

**Gitignored:** `app.db` (and WAL/SHM), `sessions/`, `logs/`, `*.log`, `server.pid`, `config.toml` (contains API keys), `chat-history.json` (UI state).

**Backup:** The CLI creates timestamped full copies (`~/.system2-auto-backup-*`) on every `system2 start` (24h cooldown, 5 max retention). This covers everything git ignores (database, sessions, config). See [CLI](packages/cli.md) and [Configuration](configuration.md).

## Initialization

`initializeKnowledge()` creates the knowledge directory structure and writes template files if they don't exist. This is idempotent, called on every server start.

## See Also

- [Agents](agents.md): system prompt construction using knowledge
- [Scheduler](scheduler.md): jobs that trigger Narrator updates
- [Configuration](configuration.md): `daily_summary_interval_minutes` setting
