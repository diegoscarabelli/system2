# Agent Tools

Agents interact with the system through custom tools defined in `src/server/agents/tools/`. Each tool is a factory function returning a [pi-coding-agent](https://github.com/badlogic/pi-mono) `AgentTool` with typed parameters (via [@sinclair/typebox](https://github.com/sinclairzx81/typebox)) and an async `execute` method.

## Tool Registration

Tools are built in `AgentHost.buildTools()` (`src/server/agents/host.ts`):

- Eight tools are always included: `bash`, `read`, `edit`, `write`, `read_system2_db`, `write_system2_db`, `message_agent`, `web_fetch`
- `show_artifact` is included for all agents: any agent can display files in the UI artifact viewer
- `set_reminder`, `cancel_reminder`, and `list_reminders` are included for all agents when a `ReminderManager` is provided
- `spawn_agent`, `terminate_agent`, and `trigger_project_story` are conditional: only agents that receive a spawner callback (Guide and Conductors) get these tools
- `resurrect_agent` is Guide-only: only the Guide receives a resurrector callback
- `web_search` is conditional on a Brave Search API key being configured

## Tool Reference

### `bash`

Execute shell commands with streaming output and optional background execution. Uses PowerShell on Windows, the default shell (bash) on macOS/Linux.

| Parameter | Type | Description |
|-----------|------|-------------|
| `command` | string | Shell command to execute |
| `cwd` | string? | Working directory (defaults to user home) |
| `run_in_background` | boolean? | If true, return immediately and deliver output as a follow-up message on completion |
| `inactivity_timeout_seconds` | number? | Inactivity timeout in seconds (10-600, default 60). Resets on every stdout/stderr output. Only takes effect when explicitly provided. |
| `total_timeout_seconds` | number? | Total wall-clock timeout in seconds (10-600, default 600). Hard cap, never resets. Only takes effect when explicitly provided. |

- **Timeout (legacy):** 120 seconds fixed timeout when neither `inactivity_timeout_seconds` nor `total_timeout_seconds` is provided. Background commands have no timeout.
- **Timeout (dual mode):** when either timeout parameter is provided, the tool uses dual timeouts: an inactivity timer that resets on every stdout/stderr data event, and a total timer that never resets. This allows long-running commands that produce regular output to run for up to 10 minutes.
- **Heartbeat protocol:** scripts can emit `::system2:: <message>` lines on stdout to reset the inactivity timer and push progress updates to the UI. Sentinel lines are stripped from the output before it reaches the agent. Example:
  ```bash
  for i in $(seq 1 100); do
    echo "::system2:: processing batch $i of 100"
    process_batch "$i"
  done
  ```
- **Output buffer:** 10MB
- **Working directory:** user's home directory (overridable via `cwd`)
- **Shell:** PowerShell (`powershell.exe`) on Windows, `/bin/bash` on macOS/Linux
- **Streaming:** output is streamed to the agent as the command runs via `onUpdate`
- **AbortSignal:** child process is killed (`SIGTERM`) when the agent session is aborted
- **Background:** when `run_in_background` is true, the tool returns immediately and delivers the result as a `followUp` custom message when the command finishes
- **Implementation:** Node.js `child_process.spawn`
- **Command blocklist:** certain catastrophic commands are hard-blocked before execution and return an error: recursive `rm` targeting `/`, `~`, or `$HOME`; the `--no-preserve-root` flag; `mkfs` (filesystem formatting); `dd` writing to raw block devices (`of=/dev/...`); `sqlite3` targeting `~/.system2/app.db` (writes must go through `write_system2_db` for push notifications). Patterns are defined in `BLOCKED_BASH_PATTERNS` and checked against the full command string. Note: the `sqlite3` blocklist only applies to System2's management database (`app.db`). Agents are free to use `bash` with any database tool (`sqlite3`, `psql`, `duckdb`, etc.) to operate on data pipeline databases directly.
- **Database access for artifacts vs. agents:** agents query external databases through `bash` (e.g., `psql -c "SELECT ..."`). HTML artifacts query the same databases through the server's postMessage bridge (see [Artifacts: Interactive Dashboards](artifacts.md#interactive-dashboards-postmessage-bridge)). The bridge uses database connections configured in `config.toml`, not the agent's shell access. Both paths can coexist: an agent might use `bash` to prototype queries, then write an HTML dashboard that uses the bridge for live data.

### `read`

Read file contents from the filesystem.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Absolute path or `~/` relative path |

Returns the file contents as a string.

### `edit`

Edit a file by replacing an exact string match, or append content to a file.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Absolute path or `~/` relative path |
| `old_string` | string? | Exact text to find (must be unique in the file). Required unless `append` is true. |
| `new_string` | string | Replacement text (replace mode) or content to append (append mode) |
| `append` | boolean? | If true, append `new_string` to the end of the file instead of replacing `old_string` |
| `commit_message` | string? | If provided and path is inside `~/.system2/`, git-commits the file with this message |

**Replace mode** (default, `append` not set):

- **Uniqueness check:** if `old_string` appears 0 or >1 times, the edit fails with an error instructing the agent to add more context
- **Insertions:** use surrounding context as `old_string` and embed new content in `new_string`
- **Preferred over `write`** for modifying existing files: only changes what is specified
- For bulk operations (e.g., find-and-replace across many lines), use `bash` with `sed`, `awk`, or similar

**Append mode** (`append: true`):

- Appends `new_string` to the end of the file
- Creates the file (and parent directories) if it does not exist
- Adds a newline separator if the existing content does not end with one
- Preferred for adding entries to logs, memory files, and similar append-only patterns

### `write`

Create a new file or write to an empty file. **Refuses to overwrite** an existing file that already contains data.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Absolute path or `~/` relative path |
| `content` | string | File content to write |
| `commit_message` | string? | If provided and path is inside `~/.system2/`, git-commits the file with this message |

Auto-creates parent directories if they don't exist. If the target file already exists and has content, the tool returns an error with a preview of the existing content and suggests using `edit` instead, or deleting the file first (`bash`: `rm <path>`) for intentional full replacement. For modifying specific parts of an existing file, use `edit`. For appending content, use `edit` with `append: true`. For operations where none of the above fit, use `bash`.

**Auto-commit (`edit` and `write`):** When `commit_message` is provided, the tool runs `git add <file> && git commit -m <message>` in `~/.system2/` after the file operation. Git failure is non-fatal: the file change still succeeds. This is the primary mechanism for version-tracking knowledge and project files.

### `read_system2_db`

Query the System2 app database (read-only).

| Parameter | Type | Description |
|-----------|------|-------------|
| `sql` | string | SQL SELECT query |

Executes against `~/.system2/app.db`. Returns rows as JSON. Only SELECT queries are allowed. **Only for System2's management database**: for data pipeline databases use `bash`. See [Database](database.md) for the schema.

### `write_system2_db`

Create or update records in the System2 app database.

| Parameter | Type | Description |
|-----------|------|-------------|
| `operation` | string | Named operation (see table below) |
| _(varies)_ | _(varies)_ | Additional params depend on operation |

Executes against `~/.system2/app.db` using structured named operations that delegate to `DatabaseClient` methods. `updated_at` is always maintained automatically. The `author` field on task comments is auto-filled from the calling agent's ID. **Only for System2's management database**: for data pipeline databases use `bash`. For ad-hoc SQL not covered by the named operations, use `rawSql` (see below). **Never use `bash` with `sqlite3` to modify `app.db`**: writes made outside `write_system2_db` bypass WebSocket push notifications and the UI will not reflect the changes.

| Operation | Required | Optional | Notes |
|-----------|----------|----------|-------|
| `createProject` | `name`, `description` | `status`, `labels`, `start_at` | **Guide only.** `status` defaults to `"todo"` |
| `updateProject` | `id` | `name`, `description`, `status`, `labels`, `start_at`, `end_at` | **Guide and Conductor only.** Conductors restricted to own project. |
| `createTask` | `project`, `title`, `description` | `status`, `priority`, `assignee`, `labels`, `parent`, `start_at` | Project-scoped. `assignee` restricted to Guide and Conductor. `status` defaults to `"todo"`, `priority` to `"medium"`. |
| `updateTask` | `id` | `title`, `description`, `status`, `priority`, `assignee`, `labels`, `parent`, `start_at`, `end_at` | Project-scoped. `assignee` restricted to Guide and Conductor. |
| `claimTask` | `id` | — | Atomically claims a `todo` task; enforces scope match (project-scoped agents: same project; project-less agents: project-less tasks only); `assignee` set to calling agent's ID. Returns `{ claimed: true, task }` or `{ claimed: false, error }`. Secondary mechanism: prefer assigned tasks. |
| `createTaskLink` | `source`, `target`, `relationship` | — | Project-scoped (checked via source task). `relationship`: `blocked_by` \| `relates_to` \| `duplicates` |
| `deleteTaskLink` | `id` | — | Project-scoped (checked via source task) |
| `createTaskComment` | `task`, `content` | — | Project-scoped. `author` auto-filled from agent ID. |
| `updateTaskComment` | `id`, `content` | — | Project-scoped. **Author-only:** only the original author can update their own comment. Replaces the entire comment body. |
| `deleteTaskComment` | `id` | — | Project-scoped |
| `createArtifact` | `file_path`, `title` | `project`, `description`, `tags` | Any agent. Project scope checked if `project` is set. |
| `updateArtifact` | `id` | `file_path`, `title`, `project`, `description`, `tags` | Any agent. Project scope checked. |
| `deleteArtifact` | `id` | — | Any agent. Project scope checked. DB row only (does not delete the file). |
| `rawSql` | `sql` | — | Execute DML (INSERT/UPDATE/DELETE/REPLACE) or SELECT (including WITH/CTE). DDL (CREATE/ALTER/DROP), PRAGMA, ATTACH/DETACH, and maintenance statements (VACUUM, REINDEX, ANALYZE) are blocked. |

Valid `status` values: `"todo"`, `"in progress"`, `"review"`, `"done"`, `"abandoned"`
Valid `priority` values: `"low"`, `"medium"`, `"high"`

**Permission model:**

- **Role checks:** `createProject` is Guide-only. `updateProject` is Guide and Conductor only (Conductors restricted to their own project). Setting `assignee` on tasks is Guide and Conductor only.
- **Author checks:** `updateTaskComment` is restricted to the original author. Other agents must post a new comment instead of editing someone else's attributed content.
- **Project scope:** if the calling agent is assigned to a project, it can only create/update/delete records belonging to that same project. Agents with no project assignment (Guide, Narrator) and records with no project association are unrestricted.

### `message_agent`

Send a message to another agent by database ID.

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent_id` | number | Target agent's database ID |
| `content` | string | Message content |
| `urgent` | boolean | Use `steer` delivery (interrupts). Default: `followUp` (waits) |

Routes through `AgentRegistry` to find the target `AgentHost`, then calls `deliverMessage()`. See [Agents](agents.md#message-delivery) for delivery modes.

### `show_artifact`

Display an artifact file in the UI panel. **Guide-only**: the Guide is the only agent that interacts with the user via the UI. Supports tabbed display (multiple artifacts open at once). See [Artifacts](artifacts.md) for the full artifact system documentation.

| Parameter | Type | Description |
|-----------|------|-------------|
| `file_path` | string | Absolute path to the artifact file. Supports `~/` prefix for home directory. |

- **DB metadata lookup:** queries the `artifact` table for title. If registered, the DB title is used as the tab label; otherwise, the filename is used.
- **Unregistered files:** files not in the `artifact` table can still be shown; the filename is used as the tab label.
- **Missing registered files:** if the file is registered but missing from disk, returns an error with the title and a hint to search for the filename.
- **Live reload:** the UI polls the file's modification time every 2 seconds for the active tab. Switching tabs also triggers a reload.

### `web_fetch`

Fetch a URL and extract readable text content.

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | string | URL to fetch |

Uses [Mozilla Readability](https://github.com/mozilla/readability) with [linkedom](https://github.com/WebReflection/linkedom) to parse HTML and extract the main content. Returns extracted text (truncated to ~20k characters by default).

### `web_search`

Search the web via the Brave Search API.

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Search query |

Returns structured results (title, URL, description). Requires a [Brave Search API](https://brave.com/search/api/) key in config.toml.

**Conditional:** only registered when `[services.brave_search]` key exists AND `[tools.web_search].enabled` is not `false`. Max results configurable via `[tools.web_search].max_results`.

### `set_reminder`

Schedule a delayed reminder for the calling agent. After the specified delay, a follow-up message containing the reminder text is delivered back to the agent via `deliverMessage()`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `delay_minutes` | number | Minutes from now (accepts fractional values). Must be 0.5 (30s) to 10,080 (7 days). |
| `message` | string | Reminder text delivered back as a follow-up message when the timer fires. |

- **Non-blocking:** uses `setTimeout` internally; the agent continues working after setting the reminder
- **Delivery:** fires as a `followUp` custom message with `sender: 0` (system sentinel)
- **In-memory only:** reminders do not survive server restarts
- **Timer handle:** `unref()`'d so it does not prevent graceful shutdown

### `cancel_reminder`

Cancel a pending reminder by its ID.

| Parameter | Type | Description |
|-----------|------|-------------|
| `reminder_id` | number | ID returned by `set_reminder`. |

Only the agent that created the reminder can cancel it. Returns whether the cancellation succeeded.

### `list_reminders`

List the calling agent's active (pending) reminders. Takes no parameters.

Returns reminder IDs, messages, and scheduled fire times.

### `spawn_agent`

Spawn a new agent (Conductor, Worker, or Reviewer) for a project.

| Parameter         | Type   | Description                                                          |
|-------------------|--------|----------------------------------------------------------------------|
| `role`            | string | `"conductor"`, `"worker"`, or `"reviewer"`                           |
| `project_id`      | number | ID of an existing project in app.db                                  |
| `initial_message` | string | Context and instructions delivered to the new agent on creation      |

Creates an agent record in app.db, starts a new `AgentHost` session, registers it in `AgentRegistry`, delivers the initial message, and returns the new agent's database ID.

**Permission model:**

- Guide may spawn Conductors, Workers, or Reviewers for any project
- Conductors may spawn Conductors, Workers, or Reviewers within their own project only
- Narrator has no spawner and cannot spawn agents

**Conditional:** only registered when the `AgentHost` is created with a `spawner` callback (all agents except Narrator).

### `trigger_project_story`

Trigger the project story workflow for a completed project. Creates a story task for the Narrator, collects all project data (agent activity, DB changes, `log.md` content), and delivers two messages to the Narrator via FIFO queue: a final project-log update and a project story data package. Returns the story task ID.

| Parameter    | Type   | Description                                |
|--------------|--------|--------------------------------------------|
| `project_id` | number | ID of the project to generate a story for  |

**When to use:** during the Conductor's close-project routine, after all tasks are resolved.

**Conditional:** only registered when the `AgentHost` is created with a `spawner` callback (Guide and Conductors).

### `terminate_agent`

Archive an active agent: abort its session, unregister from `AgentRegistry`, and mark `status: "archived"` in app.db.

| Parameter  | Type   | Description                         |
|------------|--------|-------------------------------------|
| `agent_id` | number | Database ID of the agent to archive |

**Permission model:**

- Singleton agents (Guide, Narrator) cannot be terminated
- An agent cannot terminate itself
- Only Guide and Conductor roles may terminate agents
- Conductors can only terminate agents in their own project

### `resurrect_agent`

Resurrect an archived agent: restore its session from persisted JSONL history, re-register it in `AgentRegistry`, and deliver a context message.

| Parameter  | Type   | Description                                                                                                        |
|------------|--------|--------------------------------------------------------------------------------------------------------------------|
| `agent_id` | number | Database ID of the archived agent to resurrect                                                                     |
| `message`  | string | Context message orienting the agent about the time gap, why it is being resurrected, and what work is now expected |

**Permission model:**

- Only the Guide may resurrect agents
- Singleton agents (Guide, Narrator) cannot be resurrected
- Already-active agents cannot be resurrected
- On failure, the DB status is rolled back to `archived`

**Conditional:** only registered when the `AgentHost` is created with a `resurrector` callback (Guide only).

## See Also

- [Agents](agents.md): agent roles, lifecycle, spawn/terminate/resurrect, work management
- [Database](database.md): schema for `read_system2_db` and `write_system2_db`
- [Configuration](configuration.md): web search configuration
- [UI](ui.md): artifact display and postMessage bridge
