# System2

System2 is a single-user, self-hosted AI multi-agent system for working with data. It automates the full data lifecycle — from data engineering (procurement, transformation, loading) to analysis, reporting, and dashboards. Built on a multi-agent architecture with structured memory and narrative lineage.

## Architecture

System2 is built on [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent), a TypeScript SDK for building LLM-powered coding agents. The SDK provides the core agent loop, tool execution, and session management.

### Multi-Agent System

Agent definitions are stored as Markdown files with YAML frontmatter in `packages/server/src/agents/library/`. Each agent has a specific role:

| Agent | Role |
|-------|------|
| **Guide** | User-facing agent. Detects system environment, handles questions and simple tasks directly, delegates complex work to Conductor. Singleton (one per system). |
| **Conductor** | Project orchestrator. Reads `plan.md`, breaks work into tasks, creates database schemas and pipeline code, tracks progress in database. Spawned by Guide per project. |
| **Narrator** | Documentation agent. Reviews completed work and creates `narration.md` files capturing context for future modifications. Read-only. Spawned by Conductor on project completion. |
| **Reviewer** | Validation agent. Checks SQL logic, data transformations, analytical assumptions. Generates validation reports with issues and recommendations. |

**Agent spawning:** Guide is a singleton (one per system). When complex work is needed, Guide spawns a Conductor for that project. Conductor spawns Narrator when work is complete.

### Tools

Agents interact with the system through custom tools. Each tool is a factory function returning a pi-coding-agent `AgentTool` with typed parameters, description, and an async `execute` method. Tools are registered in `AgentHost.buildTools()` — some are always available, others are conditional on configuration.

| Tool | Description | Conditional |
|------|-------------|-------------|
| `bash` | Execute shell commands (30s timeout, 10MB output buffer) | No |
| `read` | Read file contents (absolute or `~/` paths) | No |
| `write` | Write/create files, auto-creates parent directories | No |
| `query_database` | Query System2 SQLite database (read-only: projects, tasks, agents) | No |
| `message_agent` | Send a message to another agent by database ID | No |
| `show_artifact` | Display HTML file in the UI left panel (path must be within `~/.system2/`) | No |
| `web_fetch` | Fetch a URL and extract readable text content | No |
| `web_search` | Search the web via Brave Search API | Yes — requires Brave Search API key in config |

#### `web_fetch`

Fetches a URL and extracts the main content as clean, readable text — replacing the need for `bash` + `curl` which dumps raw HTML into your context window.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | required | URL to fetch |
| `max_length` | number | 20,000 | Maximum characters returned |

Uses Node.js built-in `fetch` with a 15-second timeout and `redirect: 'follow'`. HTML is parsed into a DOM using linkedom, then passed through Mozilla Readability (the same algorithm behind Firefox Reader View) to extract the article content. If Readability fails (e.g., non-article pages), a fallback strips `<script>`, `<style>`, `<nav>`, `<header>`, and `<footer>` elements and extracts body text. Non-HTML content types (PDF, images) are rejected with a clear error message.

Returns `# {title}\n\n{textContent}` as plain text, with a `[Content truncated]` marker if the output exceeds `max_length`.

#### `web_search`

Searches the web using the Brave Search API and returns structured results. Only available when a Brave Search API key is configured.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search query |
| `count` | number | from config (default 5) | Number of results (max 20) |

Returns a numbered list of results (title, URL, description) as text, plus a structured `results` array in `details` for programmatic use.

#### `show_artifact`

Displays an HTML file in the UI left panel. The path must be relative to `~/.system2/` (e.g., `projects/foo/dashboard.html`).

The server validates the path is within `~/.system2/`, checks the file exists, and emits a WebSocket message that sets the UI iframe source. The HTML content never passes through the LLM — only the file path does.

**Live reload:** When an artifact is shown, the server watches the file with `fs.watch`. Any modification triggers an immediate reload in the UI — no agent action required. Only one file is watched at a time.

#### Interactive Dashboards

Artifacts run in a sandboxed iframe (`sandbox="allow-scripts allow-same-origin"`). For dashboards that need database access, a `postMessage` bridge connects the iframe to the server:

```
Iframe → postMessage({ type: 'system2:query', requestId, sql })
  → ArtifactViewer intercepts → fetch('/api/query', { sql })
    → Server executes SELECT against SQLite → returns { rows, count }
  → ArtifactViewer posts back → postMessage({ type: 'system2:query_result', requestId, data })
```

The `/api/query` endpoint only allows `SELECT` queries. The iframe cannot access cookies, storage, or navigate the parent frame due to sandbox restrictions.

## Database Schema

The System2 app database (`app.db`) is SQLite with WAL mode for concurrent access. Query via `query_database` tool (read-only).

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
| role | TEXT | Agent specialization (`guide`, `conductor`, `narrator`, `reviewer`); guide is system-wide |
| project | INTEGER | Assigned project, NULL for guide (system-wide) |
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

## Inter-Agent Communication

Agents communicate via the `message_agent` tool. Messages are fire-and-forget — reply by calling `message_agent` back.

### `message_agent` Tool

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `agent_id` | number | required | Database ID of the target agent |
| `message` | string | required | Message content |
| `urgent` | boolean | `false` | If true, interrupts the receiver mid-turn (`steer` delivery). If false, waits for the receiver to finish current work (`followUp` delivery). |

Messages from other agents appear in your context prefixed with:
`[Message from {role} agent (id={id})]`

### Delivery Modes

| Sender | Receiver | Mode | Behavior |
|--------|----------|------|----------|
| User | Guide | `steer` (always) | Interrupts immediately — user gets priority |
| Agent | Agent | `followUp` (default) | Waits for receiver to finish current work, then delivers. If receiver is idle, a new turn starts immediately. |
| Agent | Agent | `steer` (urgent) | Interrupts receiver mid-turn — message injected between tool executions. Receiver can respond immediately and continue original work. |

### How It Works

1. You call `message_agent({ agent_id: 2, message: "Review the pipeline" })`
2. System validates the receiver exists in the database and has an active AgentHost
3. The `message_agent` tool builds the sender prefix server-side: `[Message from {role} agent (id={id})]`
4. Message is delivered to the receiver's session via `sendCustomMessage()` with `customType: 'agent_message'`
5. You get confirmation: `"Message delivered to conductor agent (id=2)."`
6. The receiver sees your message in their LLM context and can reply via `message_agent` back to you

### JSONL Persistence

Both sides record the exchange, in different forms:

**Receiver's JSONL** — `custom_message` entry:
```json
{
  "type": "custom_message",
  "id": "entry-uuid",
  "parentId": "previous-entry-id",
  "timestamp": "2026-03-04T12:00:00.000Z",
  "customType": "agent_message",
  "content": "[Message from guide agent (id=1)]\n\nPlease review the data pipeline for project 3.",
  "details": { "sender": 1, "receiver": 2, "timestamp": 1709553600000 },
  "display": false
}
```

- `content` → included in LLM context (the sender prefix `[Message from ...]` is how the receiving LLM knows who sent it)
- `details` → metadata only (not sent to LLM) — sender, receiver, timestamp for programmatic use

**Sender's JSONL** — automatic tool call recording:
- `message` entry with assistant role containing `toolCall` block (`message_agent` with args)
- `message` entry with `toolResult` role ("Message delivered to conductor agent (id=2)")

### Finding Other Agents

Use `query_database` to find agents:
```sql
SELECT id, role, status, project FROM agent WHERE status = 'active';
```

### Agent Registry

The `AgentRegistry` maps agent database IDs to their active `AgentHost` instances, enabling message routing. When the server creates an AgentHost, it registers it; when an agent is shut down, it unregisters. The `message_agent` tool uses the registry to look up the receiver's host.

## Session Persistence

Agent conversations are persisted in JSONL files using the [pi-coding-agent session format](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md). Each line is a JSON object with a tree structure (`id`, `parentId`) that supports in-place branching when users edit or regenerate responses — all history preserved in a single file.

```
~/.system2/sessions/
├── guide-1/                # Guide agent sessions (role-id)
│   └── 2026-03-02T14-30-00_abc123.jsonl
└── conductor-2/            # Conductor sessions (role-id, per project)
    └── 2026-03-02T15-00-00_def456.jsonl
```

### JSONL Entry Types

Every entry has base fields: `type`, `id`, `parentId`, and `timestamp`. The `session` header is the exception — it has `type`, `version`, `id`, `timestamp`, `cwd`, and optional `parentSession`.

| Type | Description |
|------|-------------|
| `session` | File header — version, session id, working directory |
| `message` | Conversation messages (see message roles below) |
| `compaction` | Context summarization — `summary`, `firstKeptEntryId`, `tokensBefore` |
| `branch_summary` | Summary of an abandoned branch — `fromId`, `summary` |
| `model_change` | Provider/model switch — `provider`, `modelId` |
| `thinking_level_change` | Thinking level change — `thinkingLevel` |
| `custom` | Extension data storage (not sent to LLM) — `customType`, `data` |
| `custom_message` | Extension-injected messages (sent to LLM) — `customType`, `content`, `display` |
| `label` | Bookmark on an entry — `targetId`, `label` |
| `session_info` | Session metadata — `name` |

### Message Roles

The `message` entry contains an `AgentMessage` object. The `role` field determines the shape:

| Role | Key fields |
|------|------------|
| `user` | `content` (string or text/image array) |
| `assistant` | `content` (array of `text`, `thinking`, or `toolCall` blocks), `provider`, `model`, `usage`, `stopReason` |
| `toolResult` | `toolCallId`, `toolName`, `content`, `isError` |
| `bashExecution` | `command`, `output`, `exitCode`, `cancelled`, `truncated` |
| `compactionSummary` | `summary`, `tokensBefore` |
| `branchSummary` | `summary`, `fromId` |
| `custom` | `customType`, `content`, `display` |

The `assistant` role's content blocks contain the actual LLM output: `text` (response text), `thinking` (extended thinking with signature), and `toolCall` (tool name, id, arguments). The `usage` field tracks token counts and costs per message.

Full type definitions: [`session-manager.d.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md) in the pi-coding-agent SDK.

### Auto-Compaction

When context approaches model limits, the SDK automatically summarizes older messages. The `compaction` entry contains:
- `summary`: Condensed conversation history
- `firstKeptEntryId`: Pointer to first preserved entry
- `tokensBefore`: Token count before compaction

You may see a compaction summary at the start of your context — this is normal and means your earlier conversation was summarized to make room.

### Session Rotation

When JSONL files exceed 10MB:
1. New file created with fresh session header
2. Entries from `firstKeptEntryId` through compaction are copied
3. All post-compaction entries are copied
4. Old file remains archived
5. New file picked up automatically (newer mtime)

Your context is preserved across rotation.

## File System

All System2 data lives in `~/.system2/`:

```
~/.system2/
├── config.toml     # Settings and credentials (0600 permissions)
├── app.db          # SQLite database (projects, tasks, agents)
├── server.pid      # PID file when server is running
├── sessions/       # Agent conversation history (JSONL)
│   ├── guide-1/    # Guide agent sessions
│   └── conductor-2/# Conductor sessions
├── projects/       # Project workspaces
│   └── {name}-{uuid-short}/
│       ├── plan.md
│       └── narration.md
└── logs/
    ├── system2.log   # Server logs (rotated automatically)
    └── system2.log.N # Rotated logs (system2.log.1 to system2.log.5)
```

When writing files for projects, use the project workspace directory (`~/.system2/projects/{name}-{uuid-short}/`).

Automatic backups are stored in `~/.system2-auto-backup-<timestamp>/`.
