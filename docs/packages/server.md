# @system2/server

HTTP + WebSocket server that hosts all agents (Guide and Narrator at startup, others spawned dynamically), serves the UI, and runs the scheduler.

**Source:** `packages/server/src/`
**Build:** [tsup](https://tsup.egoist.dev/) -> `dist/index.js`
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
│   └── history.ts         # MessageHistory (JSON ring buffer)
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
6. Create `MessageHistory` (ring buffer, default 1000 messages)
7. Subscribe once to Guide agent events for assistant message history capture (prevents duplicates with multiple tabs)
8. Create `Scheduler`
9. Set up Express routes
10. Create HTTP server and WebSocket server

### `start()` Method

1. Initialize Guide and Narrator agent sessions (`agentHost.initialize()`)
2. Restore previously active spawned agents (conductors, reviewers, etc.) from the database via `initializeAgentHost()`
3. Register Narrator scheduled jobs
4. Check if Narrator needs catch-up (handles server downtime / laptop sleep)
5. Register SIGTERM/SIGINT shutdown handlers
6. Start listening on configured port

### Express Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/artifact` | GET | Serve artifact file by absolute path (`?path=`) with no-cache headers |
| `/api/artifacts` | GET | List all registered artifacts with project names (for catalog UI) |
| `/api/agents` | GET | List all non-archived agents with in-memory busy state (for agents pane) |
| `/api/kanban` | GET | Kanban board data: all tasks (with project/assignee joins), projects, and active agents |
| `/api/tasks/:id` | GET | Full task detail: task row, all comments (with author role), and all linked tasks (bidirectional) |
| `/api/query` | POST | SQL query endpoint for artifact dashboards (SELECT only) |
| `/*` | GET | UI static files (if `uiDistPath` configured) |

### Graceful Shutdown

`stop()` tears down in order: scheduler -> WebSocket clients -> WebSocket server -> HTTP server -> database.

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
