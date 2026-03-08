# Agent Tools

Agents interact with the system through 8 custom tools defined in `packages/server/src/agents/tools/`. Each tool is a factory function returning a [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) `AgentTool` with typed parameters (via [@sinclair/typebox](https://github.com/sinclairzx81/typebox)) and an async `execute` method.

## Tool Registration

Tools are built in `AgentHost.buildTools()` (`packages/server/src/agents/host.ts`). Seven tools are always included; `web_search` is conditional on configuration.

## Tool Reference

### `bash`

Execute shell commands.

| Parameter | Type | Description |
|-----------|------|-------------|
| `command` | string | Shell command to execute |

- **Timeout:** 30 seconds
- **Output buffer:** 10MB
- **Working directory:** user's home directory
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
| `updateProject` | `id` | `name`, `description`, `status`, `labels`, `start_at`, `end_at` | `updated_at` auto-set |
| `createTask` | `project`, `title`, `description` | `status`, `priority`, `assignee`, `labels`, `parent`, `start_at` | `status` defaults to `"todo"`, `priority` to `"medium"` |
| `updateTask` | `id` | `title`, `description`, `status`, `priority`, `assignee`, `labels`, `parent`, `start_at`, `end_at` | `updated_at` auto-set |
| `claimTask` | `id` | — | Atomically claims a `todo` task; enforces scope match (project-scoped agents: same project; project-less agents: project-less tasks only); `assignee` set to calling agent's ID. Returns `{ claimed: true, task }` or `{ claimed: false, error }`. Secondary mechanism — prefer assigned tasks. |
| `createTaskLink` | `source`, `target`, `relationship` | — | `relationship`: `blocked_by` \| `relates_to` \| `duplicates` |
| `deleteTaskLink` | `id` | — | |
| `createTaskComment` | `task`, `content` | — | `author` auto-filled from agent ID |
| `deleteTaskComment` | `id` | — | |

Valid `status` values: `"todo"`, `"in progress"`, `"review"`, `"done"`, `"abandoned"`
Valid `priority` values: `"low"`, `"medium"`, `"high"`

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

- **Security:** validates the resolved path is within `~/.system2/` (no path traversal)
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

## See Also

- [Agents](agents.md) -- how tools are registered and used
- [Database](database.md) -- schema for `read_system2_db` and `write_system2_db`
- [Configuration](configuration.md) -- web search configuration
- [UI](packages/ui.md) -- artifact display and postMessage bridge
