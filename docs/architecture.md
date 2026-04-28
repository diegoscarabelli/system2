# Architecture Overview

System2 is a TypeScript project built on [pi-coding-agent](https://github.com/badlogic/pi-mono), a SDK for building LLM-powered coding agents. The SDK provides the core agent loop, tool execution, session management (JSONL persistence), and auto-compaction. System2 adds multi-agent orchestration, LLM failover, a knowledge/memory system, custom tools, a [scheduler](scheduler.md), and a web UI.

## Key Design Decisions

**Single user-facing agent.** The user interacts exclusively with the Guide. Other agents (Conductors, Reviewers, etc.) are spawned on demand based on the nature and scope of the work, and the Narrator operates continuously in the background. The user never addresses these agents directly. This shields the user from multi-agent complexity, bridging the throughput of parallel agents with the human's finite capacity to absorb information. See [Agents](agents.md).

**No chat sessions, continuous interaction.** There is no concept of starting a new chat. The Guide maintains a single persistent session and a structured memory system, creating an unbroken thread of interaction that accumulates memories over time rather than resetting between conversations. See [Agents](agents.md#session-management) | [Knowledge System](knowledge-system.md).

**Artifact canvas for interactive content.** The UI provides a dedicated display area where the Guide or user can surface rich, interactive content on demand: charts, dashboards, custom UIs, or any HTML/JS artifact. Artifacts are stored as files and tracked with metadata (title, description, timestamps) so they can be revisited and  refined in later conversations. See [UI](ui.md)

**Orchestrated multi-agent work.** Agents are spawned on demand based on the scope and nature of the work; others run continuously in the background. Work is broken into tasks stored in the database, then distributed and coordinated via two channels: direct messages for real-time steering and task comments for a permanent audit trail. A dedicated review role provides critical assessment before work is considered complete. Tools are gated by role and project scope. A background agent (the Narrator) continuously maintains long-term memory by writing project logs, daily summaries, and project stories, so knowledge accumulates without user involvement. See [Agents](agents.md) | [Tools](tools.md) | [Database](database.md) | [Scheduler](scheduler.md) | [Knowledge System](knowledge-system.md).

**Persistent, evolving context.** Every agent's context is assembled from three layers on each LLM call: static instructions (shared agent reference and role-specific prompt, loaded once at startup or spawn); a Knowledge Base of files re-read fresh from disk (knowledge files, plus daily summaries or a project log depending on scope), so any edit takes effect immediately; and the full conversation history replayed from a JSONL session file, with a compaction summary substituted when the context was compressed. Knowledge files are versioned in git; session JSONL files are gitignored (large, private). Session logs rotate at a configurable size threshold to prevent unbounded growth. See [Agents](agents.md#session-management) | [Knowledge System](knowledge-system.md).

**Reliable infrastructure.** Chat history, database state, and agent sessions are managed server-side; the UI is stateless and receives full history on WebSocket connect. Database writes by agents trigger push notifications over WebSocket, so UI panels update in real time without polling. API errors trigger automatic retry with exponential backoff, then failover to the next configured key or provider. Scheduled jobs run in-process and are checked for staleness on startup so missed work is caught up automatically. See [Configuration](configuration.md#automatic-failover) | [Scheduler](scheduler.md) | [WebSocket Protocol](websocket-protocol.md).

## Runtime Architecture

```
┌─────────────────────────────────────────────────────────┐
│  LLM API  (Anthropic / Cerebras / Gemini / OpenAI / ...)│
└──────────────────────────┬──────────────────────────────┘
                           │ HTTPS (multi-provider, failover)
┌──────────────────────────▼──────────────────────────────┐
│  Server (Express + WebSocket on port 4242)              │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  + per-project:     │
│  │ Guide Agent  │  │Narrator Agent│    Conductor(s)     │
│  │ (singleton)  │  │ (singleton)  │    Worker(s)        │
│  └──────┬───────┘  └──────┬───────┘    Reviewer(s)     │
│         │                 │                             │
│  ┌──────▼─────────────────▼──────────────────────────┐  │
│  │          AgentRegistry (message routing)          │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │  SQLite DB  │  │  Knowledge  │  │  Chat History   │  │
│  │  (app.db)   │  │  (markdown) │  │  (JSON ring)    │  │
│  └─────────────┘  └─────────────┘  └─────────────────┘  │
│                                                         │
│  ┌────────────────────────────────────────────────┐     │
│  │           Scheduler  (croner)                  │     │
│  └────────────────────────────────────────────────┘     │
└──────────────────────────┬──────────────────────────────┘
                           │ WebSocket
┌──────────────────────────▼──────────────────────────────┐
│  UI (React on port 3001 dev, served by server in prod)  │
│  - Multi-agent chat with streaming                      │
│  - Push-driven panels (kanban, agents, artifacts, jobs) │
│  - Artifact viewer (tabbed sandboxed iframes)           │
└─────────────────────────────────────────────────────────┘
```

See [Agents](agents.md) for agent roles, lifecycle, permissions, and tool access.

All runtime state lives in `~/.system2/`:

```
~/.system2/
├── app.db                           SQLite database (gitignored)
├── artifacts/                       Project-free reports, dashboards, exports
├── config.toml                      Settings and API keys (0600, gitignored)
├── oauth/                           OAuth credentials (0600, gitignored)
│   └── anthropic.json               Claude Pro/Max tokens
├── knowledge/                       Persistent knowledge (injected into prompts)
│   ├── conductor.md                 Conductor role-specific knowledge
│   ├── daily_summaries/             Daily activity logs
│   │   └── YYYY-MM-DD.md
│   ├── guide.md                     Guide role-specific knowledge
│   ├── infrastructure.md            Data stack, tools, environments
│   ├── memory.md                    Long-term memory (Narrator-maintained)
│   ├── narrator.md                  Narrator role-specific knowledge
│   ├── reviewer.md                  Reviewer role-specific knowledge
│   ├── user.md                      User profile, preferences, goals
│   └── worker.md                    Worker role-specific knowledge
├── artifacts/                       Project-free artifacts (not tied to any project)
├── logs/                            Server logs (gitignored)
├── projects/                        Project workspaces
│   └── {dir_name}/                  {id}_{slug} from project record (e.g. 1_linkedin-campaign)
│       ├── artifacts/               Project-scoped artifacts
│       │   ├── plan_{uuid}.md       Conductor's proposal document
│       │   └── project_story.md     Final narrative (Narrator, on completion)
│       ├── log.md                   Continuous project log (Narrator)
│       └── scratchpad/              Project-scoped working files (exploration, debugging)
├── scratchpad/                      Project-free working files (exploration, debugging)
├── server.pid                       PID file when server is running
├── sessions/                        Conversation history as JSONL (gitignored)
│   └── {role}_{id}/
├── skills/                          Reusable workflow instructions
│   └── {skill-name}/
│       └── SKILL.md                 Frontmatter (name, description, roles) + steps
└── venv/                            Shared Python environment (gitignored)
```

Most content is git-tracked. `app.db`, `sessions/`, `logs/`, and `config.toml` are gitignored.

See [Configuration](configuration.md) for `config.toml` settings and API keys.

## Project Structure

```
system2/
├── src/
│   ├── shared/    Shared TypeScript types
│   ├── server/    HTTP/WS server + agent runtime
│   ├── ui/        React chat interface
│   └── cli/       CLI entry point
├── docs/          Developer documentation
├── biome.json     Formatting/linting config
└── tsconfig.json  TypeScript config
```

**Build:** `pnpm build` runs `tsup && vite build`, producing the server/CLI bundle and UI static assets in a single step.

See detailed docs: [shared](shared.md) | [server](server.md) | [ui](ui.md) | [cli](cli.md)

## Request Lifecycle

1. The UI sends a `user_message` over WebSocket to the server.
2. The server captures the message in the chat history ring buffer and forwards it to the Guide.
3. The Guide processes the message (reading fresh knowledge files on every LLM call, calling tools, and optionally spawning Conductors) while streaming text and tool events back over WebSocket.
4. If the Guide spawns a Conductor, it is registered in the AgentRegistry and receives an initial message. It runs independently and posts updates to the Guide via `message_agent`. The Guide relays relevant progress to the user.
5. When the Guide's turn completes, the full response is persisted to the ring buffer.

See [WebSocket Protocol](websocket-protocol.md) for the full message-type reference and flow diagrams. See [Agents](agents.md) for agent-to-agent routing and message delivery modes.

## Trust and Scope

System2 is a **single-user, local system**. The server binds to `localhost` only, with no network exposure by default. There is no authentication between the UI and server; all connected clients are considered trusted. The `/api/query` endpoint accepts SQL `SELECT` statements for use by interactive artifacts, but no mutations are permitted.

Agent tools (`bash`, `read`, `write`, `edit`) run with the user's full filesystem and shell permissions. No sandboxing is applied between agents. The trust model assumes that the user controls what agents are spawned and what instructions they receive.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js, TypeScript |
| Agent SDK | pi-coding-agent |
| HTTP / WebSocket | Express, ws |
| Database | SQLite, WAL mode |
| UI | React, Zustand, Vite |
| Scheduling | croner |
| Schema validation | TypeBox |
| Package manager | pnpm |
| Lint / format | Biome |

## Platform Support

System2 runs on macOS, Linux, and Windows. Path handling uses `~/` expansion via Node.js `os.homedir()` (cross-platform). Shell commands use PowerShell on Windows and the default shell (`/bin/bash`) on macOS/Linux.
