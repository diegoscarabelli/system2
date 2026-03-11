# Architecture Overview

System2 is a TypeScript monorepo built on [pi-coding-agent](https://github.com/badlogic/pi-mono), a SDK for building LLM-powered coding agents. The SDK provides the core agent loop, tool execution, session management (JSONL persistence), and auto-compaction. System2 adds multi-agent orchestration, LLM failover, a knowledge/memory system, custom tools, a scheduler, and a web UI.

## Platform Support

System2 runs on macOS, Linux, and Windows. Path handling uses `~/` expansion via Node.js `os.homedir()` (cross-platform). Shell commands use PowerShell on Windows and the default shell (`/bin/bash`) on macOS/Linux.

## Monorepo Structure

```
system2/
├── packages/
│   ├── shared/    @system2/shared    Shared TypeScript types
│   ├── server/    @system2/server    HTTP/WS server + agent runtime
│   ├── ui/        @system2/ui        React chat interface
│   └── cli/       @system2/cli       CLI entry point
├── docs/                              Developer documentation
├── biome.json                         Formatting/linting config
├── tsconfig.json                      Root TypeScript config
└── pnpm-workspace.yaml                Workspace declaration
```

**Dependency graph:** `shared` -> `server` + `ui` -> `cli`

**Build order:** `shared` first, then `server` + `ui` in parallel, then `cli` last.

See individual package docs: [shared](packages/shared.md) | [server](packages/server.md) | [ui](packages/ui.md) | [cli](packages/cli.md)

## Runtime Architecture

```
┌─────────────────────────────────────────────────────────┐
│  CLI (system2 start)                                    │
│  - Loads config.toml                                    │
│  - Spawns server process (daemon or foreground)         │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  Server (Express + WebSocket on port 3000)              │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Guide Agent  │  │Narrator Agent│  │   Scheduler   │  │
│  │ (singleton)  │  │ (singleton)  │  │   (croner)    │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                 │                  │          │
│  ┌──────▼─────────────────▼──────────────────▼───────┐  │
│  │           AgentRegistry (message routing)         │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │  SQLite DB  │  │  Knowledge  │  │  Chat History   │  │
│  │  (app.db)   │  │  (markdown) │  │  (JSON ring)    │  │
│  └─────────────┘  └─────────────┘  └─────────────────┘  │
└──────────────────────────┬──────────────────────────────┘
                           │ WebSocket
┌──────────────────────────▼──────────────────────────────┐
│  UI (React on port 3001 dev, served by server in prod)  │
│  - Chat interface with streaming                        │
│  - Artifact display (sandboxed iframe)                  │
└─────────────────────────────────────────────────────────┘
```

## Application Directory

All runtime state lives in `~/.system2/`. See [Configuration](configuration.md) for the full directory layout.

## Key Design Decisions

**Server as source of truth.** Chat history, database state, and agent sessions are all managed server-side. The UI is stateless -- it receives history on WebSocket connect and streams updates.

**Multi-provider failover.** API errors trigger automatic retry with exponential backoff, then failover to the next key or provider. See [Configuration](configuration.md#automatic-failover).

**In-process scheduler.** Scheduled jobs run inside the server process using [Croner](https://github.com/Hexagon/croner). Since croner doesn't catch up missed jobs, the server checks staleness on startup and queues catch-up work. See [Scheduler](scheduler.md).

**Role-based agent architecture.** Four roles (Guide, Conductor, Narrator, Reviewer) with distinct lifecycles -- Guide and Narrator are persistent singletons; Conductor and Reviewer are ephemeral and project-scoped. See [Agents](agents.md).

**Push-based work management.** Conductors break work into tasks in the database, assign them to agents, and coordinate via messages. Agents check for assigned work on startup and keep task status current. See [Agents](agents.md#work-management).

**Two-channel inter-agent communication.** Direct messages (`message_agent`) for real-time coordination with steer/followUp delivery; task comments for permanent audit trail. See [Agents](agents.md#message-delivery).

**Custom tools with permission model.** Tools have role-based and project-scoped access control -- Guide-only (show_artifact), spawner-gated (spawn/terminate_agent), and config-gated (web_search). See [Tools](tools.md).

**Git-tracked knowledge.** Knowledge files and project logs live in `~/.system2/` which is a git repository. The `edit` and `write` tools accept a `commit_message` parameter for auto-committing changes. See [Knowledge System](knowledge-system.md).

**Session persistence and rotation.** Agent sessions are JSONL files with tree-structured branching and auto-compaction. Long-running singletons rotate at a configurable size threshold to prevent unbounded growth. See [Agents](agents.md#session-management).

**Dynamic system prompts.** Knowledge files and daily summaries are re-read on every LLM API call (not cached). This means any agent or the user can edit knowledge files and changes take effect immediately. Prompt caching (such as Anthropic and OpenAI) makes the static prefix cheap to resend. See [Agents](agents.md).
