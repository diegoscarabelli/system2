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

### `query_database`

Query the System2 SQLite database (read-only).

| Parameter | Type | Description |
|-----------|------|-------------|
| `sql` | string | SQL SELECT query |

Executes against the app database (`~/.system2/app.db`). Returns rows as JSON. Only SELECT queries are allowed. See [Database](database.md) for the schema.

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
- [Database](database.md) -- schema for `query_database`
- [Configuration](configuration.md) -- web search configuration
- [UI](packages/ui.md) -- artifact display and postMessage bridge
