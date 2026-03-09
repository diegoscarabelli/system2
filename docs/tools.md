# Agent Tools

Agents interact with the system through custom tools defined in `packages/server/src/agents/tools/`. Each tool is a factory function returning a [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) `AgentTool` with typed parameters (via [@sinclair/typebox](https://github.com/sinclairzx81/typebox)) and an async `execute` method.

## Tool Registration

Tools are built in `AgentHost.buildTools()` (`packages/server/src/agents/host.ts`):

- Eight tools are always included: `bash`, `read`, `write`, `read_system2_db`, `write_system2_db`, `message_agent`, `show_artifact`, `web_fetch`
- `spawn_agent` and `terminate_agent` are conditional — only agents that receive a spawner callback (Guide and Conductors) get these tools
- `web_search` is conditional on a Brave Search API key being configured

## Tool Reference

### `bash`

Execute shell commands. Uses PowerShell on Windows, the default shell (bash) on macOS/Linux.

| Parameter | Type | Description |
|-----------|------|-------------|
| `command` | string | Shell command to execute |

- **Timeout:** 30 seconds
- **Output buffer:** 10MB
- **Working directory:** user's home directory
- **Shell:** PowerShell (`powershell.exe`) on Windows, default shell on macOS/Linux
- **Implementation:** Node.js `child_process.exec`

### `read`

Read file contents from the filesystem.

| Parameter | Type | Description |
|-----------|------|-------------|
| `file_path` | string | Absolute path or `~/` relative path |

Returns the file contents as a string.

### `write`

Write or create files on the filesystem.

| Parameter | Type | Description |
|-----------|------|-------------|
| `file_path` | string | Absolute path or `~/` relative path |
| `content` | string | File content to write |

Auto-creates parent directories if they don't exist.

### `read_system2_db`

Query the System2 app database (read-only).

| Parameter | Type | Description |
|-----------|------|-------------|
| `sql` | string | SQL SELECT query |

Executes against `~/.system2/app.db`. Returns rows as JSON. Only SELECT queries are allowed. **Only for System2's management database** — for data pipeline databases use `bash`. See [Database](database.md) for the schema.

### `write_system2_db`

Create or update records in the System2 app database.

| Parameter | Type | Description |
|-----------|------|-------------|
| `operation` | string | Named operation (see table below) |
| _(varies)_ | _(varies)_ | Additional params depend on operation |

Executes against `~/.system2/app.db` using structured named operations that delegate to `DatabaseClient` methods. `updated_at` is always maintained automatically. The `author` field on task comments is auto-filled from the calling agent's ID. **Only for System2's management database** — for data pipeline databases use `bash`. For ad-hoc SQL not covered by these operations, use `bash` with `sqlite3 ~/.system2/app.db`.

| Operation | Required | Optional | Notes |
|-----------|----------|----------|-------|
| `createProject` | `name`, `description` | `status`, `labels`, `start_at` | **Guide only.** `status` defaults to `"todo"` |
| `updateProject` | `id` | `name`, `description`, `status`, `labels`, `start_at`, `end_at` | **Guide and Conductor only.** Conductors restricted to own project. |
| `createTask` | `project`, `title`, `description` | `status`, `priority`, `assignee`, `labels`, `parent`, `start_at` | Project-scoped. `assignee` restricted to Guide and Conductor. `status` defaults to `"todo"`, `priority` to `"medium"`. |
| `updateTask` | `id` | `title`, `description`, `status`, `priority`, `assignee`, `labels`, `parent`, `start_at`, `end_at` | Project-scoped. `assignee` restricted to Guide and Conductor. |
| `claimTask` | `id` | — | Atomically claims a `todo` task; enforces scope match (project-scoped agents: same project; project-less agents: project-less tasks only); `assignee` set to calling agent's ID. Returns `{ claimed: true, task }` or `{ claimed: false, error }`. Secondary mechanism — prefer assigned tasks. |
| `createTaskLink` | `source`, `target`, `relationship` | — | Project-scoped (checked via source task). `relationship`: `blocked_by` \| `relates_to` \| `duplicates` |
| `deleteTaskLink` | `id` | — | Project-scoped (checked via source task) |
| `createTaskComment` | `task`, `content` | — | Project-scoped. `author` auto-filled from agent ID. |
| `deleteTaskComment` | `id` | — | Project-scoped |

Valid `status` values: `"todo"`, `"in progress"`, `"review"`, `"done"`, `"abandoned"`
Valid `priority` values: `"low"`, `"medium"`, `"high"`

**Permission model:**

- **Role checks:** `createProject` is Guide-only. `updateProject` is Guide and Conductor only (Conductors restricted to their own project). Setting `assignee` on tasks is Guide and Conductor only.
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

Display an HTML file in the UI's left panel.

| Parameter | Type | Description |
|-----------|------|-------------|
| `file_path` | string | Path relative to `~/.system2/` |

- **Live reload:** the server starts an `fs.watch` on the file; modifications trigger automatic UI refresh
- **Only one artifact watched at a time** -- showing a new artifact closes the previous watcher

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

### `spawn_agent`

Spawn a new agent (Conductor or Reviewer) for a project.

| Parameter         | Type   | Description                                                          |
|-------------------|--------|----------------------------------------------------------------------|
| `role`            | string | `"conductor"` or `"reviewer"`                                        |
| `project_id`      | number | ID of an existing project in app.db                                  |
| `initial_message` | string | Context and instructions delivered to the new agent on creation      |

Creates an agent record in app.db, starts a new `AgentHost` session, registers it in `AgentRegistry`, delivers the initial message, and returns the new agent's database ID.

**Permission model:**

- Guide may spawn Conductors or Reviewers for any project
- Conductors may spawn Conductors or Reviewers within their own project only
- Narrator has no spawner and cannot spawn agents

**Conditional:** only registered when the `AgentHost` is created with a `spawner` callback (all agents except Narrator).

### `terminate_agent`

Archive an active agent — abort its session, unregister from `AgentRegistry`, and mark `status: "archived"` in app.db.

| Parameter  | Type   | Description                         |
|------------|--------|-------------------------------------|
| `agent_id` | number | Database ID of the agent to archive |

**Permission model:**

- Singleton agents (Guide, Narrator) cannot be terminated
- An agent cannot terminate itself
- Only Guide and Conductor roles may terminate agents
- Conductors can only terminate agents in their own project

## See Also

- [Agents](agents.md) -- agent roles, lifecycle, spawn/terminate, work management
- [Database](database.md) -- schema for `read_system2_db` and `write_system2_db`
- [Configuration](configuration.md) -- web search configuration
- [UI](packages/ui.md) -- artifact display and postMessage bridge
