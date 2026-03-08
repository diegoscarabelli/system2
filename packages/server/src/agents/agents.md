# System2

System2 is a single-user, self-hosted AI multi-agent system for working with data. It automates the full data lifecycle — from data engineering (procurement, transformation, loading) to analysis, reporting, and dashboards. Built on a multi-agent architecture with structured memory and narrative lineage.

## Architecture

System2 is built on [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent), a TypeScript SDK for building LLM-powered coding agents. The SDK provides the core agent loop, tool execution, and session management.

### Multi-Agent System

Agent definitions are stored as Markdown files with YAML frontmatter in `packages/server/src/agents/library/`. Each agent has a specific role:

| Agent | Role |
|-------|------|
| **Guide** | User-facing agent. Detects system environment, handles questions and simple tasks directly, delegates complex work to Conductor. Singleton (one per system, cross-project). Populates `knowledge/infrastructure.md` and `knowledge/user.md` during onboarding and ongoing conversations. Writes important facts to the `## Notes` section of `knowledge/memory.md` for long-term retention. |
| **Conductor** | Project orchestrator. Reads `plan.md`, breaks work into tasks, creates database schemas and pipeline code, tracks progress in database. Spawned by Guide per project. Can write important facts to the `## Notes` section of `knowledge/memory.md`. |
| **Narrator** | Memory keeper. Maintains long-term memory (`knowledge/memory.md`) and creates daily activity summaries (`knowledge/daily_summaries/YYYY-MM-DD.md`). Singleton (one per system, cross-project). Runs on a schedule: appends to the daily summary every 30 minutes (configurable), updates `memory.md` every 24 hours. |
| **Reviewer** | Validation agent. Checks SQL logic, data transformations, analytical assumptions. Generates validation reports with issues and recommendations. |

**Agent lifecycle:** Guide and Narrator are singletons — created at server startup, sessions persist indefinitely. Conductor and Reviewer are project-scoped — spawned per project, archived when done.

**Agent spawning:** When complex work is needed, Guide spawns a Conductor for that project. Conductor may spawn Reviewers for validation. The Narrator is not spawned — it runs independently on a schedule.

### Tools

Agents interact with the system through custom tools registered in `AgentHost.buildTools()`.

| Tool | Description | Conditional |
|------|-------------|-------------|
| `bash` | Execute shell commands (30s timeout, 10MB output buffer) | No |
| `read` | Read file contents (absolute or `~/` paths) | No |
| `write` | Write/create files, auto-creates parent directories | No |
| `read_system2_db` | Query System2 app database `~/.system2/app.db` (SELECT only). Not for data pipeline databases. | No |
| `write_system2_db` | Create/update records in System2 app database `~/.system2/app.db` via named operations. Not for data pipeline databases. | No |
| `message_agent` | Send a message to another agent by database ID | No |
| `show_artifact` | Display HTML file in the UI left panel (path must be within `~/.system2/`) | No |
| `web_fetch` | Fetch a URL and extract readable text content | No |
| `web_search` | Search the web via Brave Search API | Yes — requires Brave Search API key in config |

#### `read_system2_db`

Executes a SQL SELECT query against `~/.system2/app.db` and returns rows as JSON. Use this to look up projects, tasks, agents, task links, and comments. **Only for the System2 management database** — for data pipeline databases (TimescaleDB, DuckDB, etc.) use `bash`.

#### `write_system2_db`

Creates and updates records in `~/.system2/app.db` via structured named operations. `updated_at` is maintained automatically. When creating a task comment, `author` is auto-filled with your agent ID. **Only for the System2 management database.** For ad-hoc SQL not covered here (bulk updates, complex transactions), use `bash` with `sqlite3 ~/.system2/app.db`.

| Operation | Required params | Optional params | Notes |
|-----------|----------------|-----------------|-------|
| `createProject` | `name`, `description` | `status`, `labels`, `start_at` | `status` defaults to `"todo"` |
| `updateProject` | `id` | `name`, `description`, `status`, `labels`, `start_at`, `end_at` | `updated_at` auto-set |
| `createTask` | `project`, `title`, `description` | `status`, `priority`, `assignee`, `labels`, `parent`, `start_at` | `status` defaults to `"todo"`, `priority` to `"medium"` |
| `updateTask` | `id` | `title`, `description`, `status`, `priority`, `assignee`, `labels`, `parent`, `start_at`, `end_at` | `updated_at` auto-set |
| `createTaskLink` | `source`, `target`, `relationship` | — | `relationship`: `blocked_by` \| `relates_to` \| `duplicates` |
| `deleteTaskLink` | `id` | — | |
| `createTaskComment` | `task`, `content` | — | `author` auto-filled from your agent ID |
| `deleteTaskComment` | `id` | — | |

Valid `status` values: `"todo"`, `"in progress"`, `"review"`, `"done"`, `"abandoned"`
Valid `priority` values: `"low"`, `"medium"`, `"high"`

#### `web_fetch`

Fetches a URL and returns the main content as clean, readable text. Non-HTML content (PDF, images) is rejected.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | required | URL to fetch |
| `max_length` | number | 20,000 | Maximum characters returned |

#### `web_search`

Searches the web using the Brave Search API. Only available when a Brave Search API key is configured.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search query |
| `count` | number | from config (default 5) | Number of results (max 20) |

Returns a numbered list of results (title, URL, description) as text, plus a structured `results` array in `details` for programmatic use.

#### `show_artifact`

Displays an HTML file in the UI left panel. The path must be relative to `~/.system2/` (e.g., `projects/foo/dashboard.html`). The HTML content never passes through the LLM — only the file path does.

**Live reload:** When an artifact is shown, the server watches the file with `fs.watch`. Any modification triggers an immediate reload in the UI — no agent action required. Only one file is watched at a time.

**Interactive dashboards:** Artifacts run in a sandboxed iframe. Dashboards can query the database via a `postMessage` bridge — post `{ type: 'system2:query', requestId, sql }` and receive `{ type: 'system2:query_result', requestId, data }`. Only SELECT queries are allowed.

## Database Schema

The System2 app database (`app.db`) is SQLite with WAL mode for concurrent access. Query via `read_system2_db` (SELECT only) or write via `write_system2_db` (named operations).

**project** — A data project managed by System2 agents
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto-incrementing unique identifier |
| name | TEXT | Project name |
| description | TEXT | Project description |
| status | TEXT | Current progress state (`todo`, `in progress`, `review`, `done`, `abandoned`) |
| labels | TEXT | JSON array of string labels for categorization |
| start_at | TEXT | ISO 8601 timestamp when work began |
| end_at | TEXT | ISO 8601 timestamp when work completed |
| created_at | TEXT | Row creation timestamp |
| updated_at | TEXT | Last modification timestamp |

**agent** — An AI agent that performs work within System2, assigned to projects or system-wide
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto-incrementing unique identifier |
| role | TEXT | Agent specialization (`guide`, `conductor`, `narrator`, `reviewer`) |
| project | INTEGER | Assigned project, NULL for Guide and Narrator (system-wide) |
| status | TEXT | Current lifecycle state (`idle`, `active`, `archived`) |
| created_at | TEXT | Row creation timestamp |
| updated_at | TEXT | Last modification timestamp |

**task** — A unit of work within a project or standalone
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto-incrementing unique identifier |
| parent | INTEGER | Parent task for subtask hierarchy, NULL for top-level tasks |
| project | INTEGER | Parent project, NULL for standalone tasks |
| title | TEXT | Short task title |
| description | TEXT | Detailed task description |
| status | TEXT | Current progress state (`todo`, `in progress`, `review`, `done`, `abandoned`) |
| priority | TEXT | Task urgency level (`low`, `medium`, `high`) |
| assignee | INTEGER | Agent responsible for this task, NULL if unassigned |
| labels | TEXT | JSON array of string labels for categorization |
| start_at | TEXT | ISO 8601 timestamp when work began |
| end_at | TEXT | ISO 8601 timestamp when work completed |
| created_at | TEXT | Row creation timestamp |
| updated_at | TEXT | Last modification timestamp |

**task_link** — Directed link between two tasks (blocked_by, relates_to, duplicates)
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto-incrementing unique identifier |
| source | INTEGER | The task that has the relationship |
| target | INTEGER | The task being referenced |
| relationship | TEXT | `blocked_by`, `relates_to`, `duplicates` |
| created_at | TEXT | Row creation timestamp |
| updated_at | TEXT | Last modification timestamp |

**task_comment** — A comment on a task, authored by an agent
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto-incrementing unique identifier |
| task | INTEGER | The task being commented on |
| author | INTEGER | The agent who wrote the comment |
| content | TEXT | Comment body |
| created_at | TEXT | Row creation timestamp |
| updated_at | TEXT | Last modification timestamp |

## Knowledge Directory

System2 maintains a knowledge directory at `~/.system2/knowledge/` for persistent memory across sessions. Files are created with templates during onboarding and curated over time by agents.

### Files

| File | Purpose | Written by | Format |
|------|---------|------------|--------|
| `infrastructure.md` | Data stack details (databases, orchestrator, git repos, tools) | Guide (onboarding + ongoing) | Edit-based |
| `user.md` | Facts about the user for personalized assistance | Guide | Edit-based |
| `memory.md` | Long-term memory synthesized from daily summaries and agent notes | Narrator (update every 24h), any agent (Notes section) | Edit-based, YAML frontmatter |
| `daily_summaries/YYYY-MM-DD.md` | Daily activity summary | Narrator (append every 30 min, configurable) | Append-only, YAML frontmatter |

### memory.md

Structured document with table of contents, maintained by the Narrator for coherence. Contains a `## Notes` section where any agent can write important facts during work. The Narrator consolidates notes into the document body during memory updates and clears them.

YAML frontmatter tracks `last_narrator_update_ts` (ISO 8601 timestamp). Set to creation time during onboarding.

### Daily Summaries

Append-only files in `knowledge/daily_summaries/`. The scheduler creates new files when needed and pre-computes all activity data. The Narrator appends narrative sections and updates the frontmatter timestamp.

YAML frontmatter tracks `last_narrator_update_ts` (ISO 8601 timestamp).

**Scheduler pre-computation:** The scheduler job (not the Narrator) handles all deterministic work:
1. Reads previous context (last 20 lines of most recent summary) for continuity
2. Creates today's file if it doesn't exist (with empty `last_narrator_update_ts` frontmatter)
3. Resolves `last_run_ts` via fallback chain: today's frontmatter → most recent summary frontmatter → memory.md frontmatter → interval ago
4. Collects full JSONL session records from all non-archived agents in the time window
5. Queries database for changes (tasks, projects, comments, links) in the time window
6. Sends a single message to the Narrator with all data included

The Narrator then reviews the provided data, optionally investigates further (git diffs, artifacts, additional queries), synthesizes a narrative, appends it, and updates the frontmatter.

### Git Tracking

`~/.system2/` is a git repository (initialized on first `system2 start`). The Narrator uses `git log` and `git diff` to track what changed and when. Binary files (app.db, WAL) and runtime files (PID, logs) are gitignored. The Narrator commits after each daily summary append and memory.md update.

### Scheduler

An in-process scheduler (croner) triggers jobs that pre-compute activity data and send messages to the Narrator. If the Narrator is mid-turn, messages queue until the current turn finishes. On startup, a catch-up check queues immediate narration if `last_narrator_update_ts` is stale (croner does not catch up missed jobs after sleep/shutdown).

The daily summary interval is configurable via `[scheduler] daily_summary_interval_minutes` in `config.toml` (default: 30).

| Job | Schedule | Action |
|-----|----------|--------|
| daily-summary | `*/<interval> * * * *` | Collect activity and send to Narrator for daily summary |
| memory-update | `0 4 * * *` | List daily summaries and send to Narrator for memory update |

## System Prompt & Context

LLM APIs are stateless — every API call sends the full system prompt and conversation history. The Pi SDK manages this transparently: it persists conversation history in JSONL files, reconstructs the message array on each call, and handles auto-compaction when context limits approach.

### System Prompt Construction

Each agent's system prompt is assembled from four layers:

1. **agents.md** (this file) — shared architecture reference, database schema, tools, communication protocols. Loaded once at agent initialization.
2. **`library/{role}.md`** — agent-specific instructions (e.g., `guide.md`, `narrator.md`). Loaded once at agent initialization.
3. **Knowledge files** — `infrastructure.md`, `user.md`, `memory.md` from `~/.system2/knowledge/`. **Refreshed on every LLM call** — the system prompt override reads these files dynamically, so changes made by any agent (or the user) are reflected in the next API call without restarting the server.
4. **Recent daily summaries** — The two most recent daily summary files from `~/.system2/knowledge/daily_summaries/` (by filename sort). Provides recent activity context so agents are aware of what happened recently without needing to read files explicitly. **Refreshed on every LLM call.**

Knowledge files and daily summaries are only included if they exist and have more than 10 lines (to skip empty templates or stub files).

### What This Means for Agents

- Your instructions (`{role}.md`) and this reference (`agents.md`) are always in your context.
- Knowledge files (`infrastructure.md`, `user.md`, `memory.md`) and the two most recent daily summaries reflect the latest on-disk state — if another agent updates `memory.md` or appends to a daily summary, you see the change on your next turn.
- Prompt caching (Anthropic) makes resending the same system prompt prefix cheap — the static portion (agents.md + role instructions) hits the cache, and only the refreshed knowledge section is reprocessed.

## Inter-Agent Communication

Agents communicate via the `message_agent` tool. Messages are fire-and-forget — reply by calling `message_agent` back.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `agent_id` | number | required | Database ID of the target agent |
| `message` | string | required | Message content |
| `urgent` | boolean | `false` | If true, interrupts the receiver mid-turn. If false, waits for the receiver to finish current work. |

Messages from other agents appear in your context prefixed with:
`[Message from {role} agent (id={id})]`

Use `read_system2_db` to find agents:
```sql
SELECT id, role, status, project FROM agent WHERE status = 'active';
```

## Session Persistence

Every agent gets its own session directory with JSONL persistence. Sessions persist across server restarts — conversations are restored from disk automatically.

```
~/.system2/sessions/
├── guide_1/                # Guide agent (singleton, persistent)
│   └── 2026-03-02T14-30-00_abc123.jsonl
├── narrator_2/             # Narrator agent (singleton, persistent)
│   └── 2026-03-03T09-00-00_def456.jsonl
└── conductor_3/            # Conductor agent (project-scoped, archived when done)
    └── 2026-03-02T15-00-00_ghi789.jsonl
```

**Auto-compaction:** When context approaches model limits, the SDK automatically summarizes older messages. You may see a compaction summary at the start of your context — this is normal and means your earlier conversation was summarized to make room.

**Session rotation:** When JSONL files exceed 10MB, a new file is created with the compacted history carried over. Your context is preserved across rotation.

## File System

All System2 data lives in `~/.system2/`:

```
~/.system2/
├── .git/               # Git tracking for text files
├── .gitignore          # Excludes app.db, logs, server.pid
├── config.toml         # Settings and credentials (0600 permissions)
├── app.db              # SQLite database (projects, tasks, agents)
├── server.pid          # PID file when server is running
├── knowledge/          # Persistent memory (git-tracked)
│   ├── infrastructure.md  # Data stack details
│   ├── user.md            # User profile
│   ├── memory.md          # Long-term memory (YAML frontmatter)
│   └── daily_summaries/   # Daily activity summaries
│       └── YYYY-MM-DD.md  # Daily summary (append-only, YAML frontmatter)
├── sessions/           # Agent conversation history (JSONL)
│   ├── guide_1/        # Guide agent (singleton, persistent)
│   ├── narrator_2/     # Narrator agent (singleton, persistent)
│   └── conductor_3/    # Conductor agent (project-scoped, archived when done)
├── projects/           # Project workspaces
│   └── {name}-{uuid-short}/
│       ├── plan.md
│       └── narration.md
└── logs/
    ├── system2.log     # Server logs (rotated automatically)
    └── system2.log.N   # Rotated logs (system2.log.1 to system2.log.5)
```

When writing files for projects, use the project workspace directory (`~/.system2/projects/{name}-{uuid-short}/`).

Automatic backups are stored in `~/.system2-auto-backup-<timestamp>/`.
