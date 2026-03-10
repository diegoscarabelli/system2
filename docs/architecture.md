# Architecture Overview

System2 is a TypeScript monorepo built on [pi-coding-agent](https://github.com/badlogic/pi-mono), a SDK for building LLM-powered coding agents. The SDK provides the core agent loop, tool execution, session management (JSONL persistence), and auto-compaction. System2 adds multi-agent orchestration, LLM failover, a knowledge/memory system, custom tools, a scheduler, and a web UI.

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
│  CLI (system2 start)                                     │
│  - Loads config.toml                                     │
│  - Spawns server process (daemon or foreground)          │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  Server (Express + WebSocket on port 3000)               │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Guide Agent  │  │Narrator Agent│  │   Scheduler   │  │
│  │ (singleton)  │  │ (singleton)  │  │   (croner)    │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                 │                   │          │
│  ┌──────▼─────────────────▼───────────────────▼───────┐  │
│  │            AgentRegistry (message routing)          │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │  SQLite DB  │  │  Knowledge  │  │  Chat History   │  │
│  │  (app.db)   │  │  (markdown) │  │  (JSON ring)    │  │
│  └─────────────┘  └─────────────┘  └─────────────────┘  │
└──────────────────────────┬──────────────────────────────┘
                           │ WebSocket
┌──────────────────────────▼──────────────────────────────┐
│  UI (React on port 3001 in dev, served by server in prod)│
│  - Chat interface with streaming                         │
│  - Artifact display (sandboxed iframe)                   │
└─────────────────────────────────────────────────────────┘
```

## Application Directory

All runtime state lives in `~/.system2/`. See [Configuration](configuration.md) for the full directory layout.

## Key Design Decisions

**Server as source of truth.** Chat history, database state, and agent sessions are all managed server-side. The UI is stateless -- it receives history on WebSocket connect and streams updates.

**Dynamic system prompts.** Knowledge files and daily summaries are re-read on every LLM API call (not cached). This means any agent or the user can edit knowledge files and changes take effect immediately. Anthropic's prompt caching makes the static prefix cheap to resend. See [Agents](agents.md).

**In-process scheduler.** Scheduled jobs run inside the server process using [Croner](https://github.com/Hexagon/croner). Since croner doesn't catch up missed jobs, the server checks staleness on startup and queues catch-up work. See [Scheduler](scheduler.md).

**Multi-provider failover.** API errors trigger automatic retry with exponential backoff, then failover to the next key or provider. See [Configuration](configuration.md#automatic-failover).
