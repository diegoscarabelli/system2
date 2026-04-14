# Server

HTTP + WebSocket server that hosts all agents (Guide and Narrator at startup, others spawned dynamically), serves the UI, and runs the scheduler.

**Source:** `src/server/`
**Build:** [tsup](https://tsup.egoist.dev/) (part of `pnpm build`)
**Dependencies:** [Express](https://expressjs.com/), [ws](https://github.com/websockets/ws), [pi-coding-agent](https://github.com/badlogic/pi-mono), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), [Croner](https://github.com/Hexagon/croner)

## Source Structure

```
src/
├── server.ts              # Server class (Express + WS + agent init)
├── index.ts               # Package exports
├── agents/
│   ├── host.ts            # AgentHost (session management, failover)
│   ├── registry.ts        # AgentRegistry (ID -> AgentHost map)
│   ├── auth-resolver.ts   # Multi-provider key management
│   ├── retry.ts           # Exponential backoff logic
│   ├── session-rotation.ts # JSONL file rotation at 10MB
│   ├── types.ts           # Custom message type declarations
│   ├── agents.md          # Shared reference (prepended to all system prompts)
│   ├── library/           # Agent identity and system instructions (guide.md, conductor.md, narrator.md, reviewer.md)
│   └── tools/             # Agent tools (see docs/tools.md)
├── db/
│   ├── schema.sql         # SQLite schema
│   └── client.ts          # DatabaseClient class
├── chat/
│   ├── history.ts         # MessageHistory (JSON ring buffer)
│   └── summarizer.ts      # ConversationSummarizer (timer-based LLM summaries)
├── llm/
│   └── oneshot.ts         # One-shot LLM utility (completeSimple wrapper)
├── knowledge/
│   ├── init.ts            # Knowledge directory initialization
│   ├── templates.ts       # Default file templates
│   └── git.ts             # Git repo setup for ~/.system2/
├── scheduler/
│   ├── scheduler.ts       # Croner wrapper
│   └── jobs.ts            # Daily summary + memory update jobs
└── websocket/
    └── handler.ts         # WebSocket message handling
```

## Server Class (`server.ts`)

The `Server` class is the main entry point. It accepts a `ServerConfig` and orchestrates all subsystems.

### Initialization Sequence

1. Create `DatabaseClient` (SQLite with WAL mode)
2. Initialize knowledge directory and git repo (idempotent)
3. Create `AgentRegistry`
4. Create Guide agent (singleton via `db.getOrCreateGuideAgent()`)
5. Create Narrator agent (singleton via `db.getOrCreateNarratorAgent()`)
6. Subscribe to each agent's events for assistant message history capture into per-agent chat caches (prevents duplicates with multiple tabs)
7. Wire push notification callbacks (`onDatabaseWrite`, `onBusyChange`, `onAgentTerminate`) into agent hosts
8. Resolve Narrator model and create `ConversationSummarizer` (summarizes user-agent interactions for Guide notification)
9. Create `Scheduler`
10. Set up Express routes
11. Create HTTP server and WebSocket server

### `start()` Method

1. Initialize Guide and Narrator agent sessions (`agentHost.initialize()`)
2. Restore previously active spawned agents (conductors, reviewers, etc.) from the database via `initializeAgentHost()`
3. Recover stale job executions from previous crash (`failStaleJobExecutions`)
4. Register Narrator scheduled jobs
5. Check if Narrator needs catch-up (handles server downtime / laptop sleep)
6. Register SIGTERM/SIGINT shutdown handlers
7. Start listening on configured port

### Express Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/artifact` | GET | Serve artifact file by absolute path (`?path=`) with no-cache headers |
| `/api/artifacts` | GET | List all registered artifacts with project names (for catalog UI) |
| `/api/agents` | GET | List all non-archived agents with in-memory busy state (for agents pane) |
| `/api/kanban` | GET | Kanban board data: all tasks (with project/assignee joins), projects, and active agents |
| `/api/job-executions` | GET | Scheduler job execution history (query params: `job_name`, `status`, `limit`) |
| `/api/tasks/:id` | GET | Full task detail: task row, all comments (with author role), and all linked tasks (bidirectional) |
| `/api/query` | POST | SQL query endpoint for artifact dashboards (SELECT only) |
| `/*` | GET | UI static files (if `uiDistPath` configured) |

### Push Broadcasts

The server broadcasts lightweight WebSocket notifications when state changes, so UI panels update in real time without polling. Five push message types exist: `board_changed` (projects, tasks, links, comments), `agents_changed` (spawn/terminate/resurrect), `artifacts_changed`, `job_executions_changed`, and `agent_busy_changed` (inline busy/context data).

Push notifications flow through callbacks threaded into subsystems:

- **`onDatabaseWrite(entity)`**: fired by `write_system2_db` after each mutation, mapped to the appropriate push type by entity name
- **`onBusyChange(agentId, busy, contextPercent)`**: fired by `AgentHost` when message processing starts/ends
- **`onAgentTerminate()`**: fired by `terminate_agent` after archiving, broadcasts `agents_changed`
- **`onJobChange()`**: fired by `trackJobExecution` on job lifecycle transitions

All broadcasts are debounced per message type (50ms) to coalesce rapid successive writes. Callback failures are caught with best-effort try/catch so they never break the caller.

### Graceful Shutdown

`stop()` cancels pending debounced broadcasts, then tears down in order: scheduler -> WebSocket clients -> WebSocket server -> HTTP server -> database.

1. Stop all scheduled cron jobs
2. Send `close(1001, "server shutting down")` to every connected WebSocket client (clean close handshake)
3. Start a 2-second grace timer; when it fires, `terminate()` any clients that haven't completed the handshake
4. Wait for `wss.close()` callback (fires once all clients are gone)
5. Call `httpServer.closeAllConnections()` to drop lingering HTTP keep-alive sockets
6. Close the HTTP server
7. Close the database

## Key Subsystems

Each subsystem has its own documentation page:

- **Agents:** [AgentHost, AgentRegistry, AuthResolver](../agents.md)
- **Tools:** [Agent tools](../tools.md)
- **Database:** [SQLite database and client](../database.md)
- **WebSocket:** [Protocol and handler](../websocket-protocol.md)
- **Knowledge:** [Files, memory, git tracking](../knowledge-system.md)
- **Scheduler:** [Croner jobs and pipelines](../scheduler.md)

## See Also

- [Architecture](../architecture.md): how the server fits in the overall system
- [CLI](cli.md): how `system2 start` launches the server
- [Configuration](../configuration.md): `ServerConfig` and config.toml mapping
