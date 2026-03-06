# System2

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D8-orange.svg)](package.json)

A single-user, self-hosted AI multi-agent system for working with data.

## Table of Contents

- [Overview](#overview)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [CLI Reference](#cli-reference)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
  - [Multi-Agent System](#multi-agent-system)
  - [System Prompt](#system-prompt)
  - [Agent Tools](#agent-tools)
  - [Message Delivery](#message-delivery)
  - [Session Persistence](#session-persistence)
  - [Database Schema](#database-schema)
  - [Knowledge & Memory](#knowledge--memory)
- [Artifact Display](#artifact-display)
- [Server & Protocol](#server--protocol)
- [Web UI](#web-ui)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

> **Developer docs:** For in-depth architecture, package internals, and contributor guides, see [docs/](docs/README.md).

## Overview

System2 is an AI data team that automates the full data lifecycle - from data engineering (procurement, transformation, loading) to analysis, reporting, and dashboards. Built on a multi-agent architecture with structured memory and narrative lineage.

**Key features:**
- **Cross-platform**: Works on macOS, Linux, and Windows
- **Automatic failover**: Seamless switching between LLM providers and API keys
- **Multi-agent system**: Guide (user-facing), Conductor (project orchestrator), and specialized data agents
- **Narrative lineage**: Historical context captured in readable narration.md files, which provide basis for self-improvement and personalization
- **Statistical rigor**: Built-in checking for p-hacking, multiple comparisons, proper intervals


## Requirements

- Node.js 18+
- pnpm 8+
- At least one LLM provider API key (Anthropic, Google, or OpenAI)

## Quick Start

```bash
# Install globally
npm install -g system2

# Interactive setup - creates ~/.system2/ and writes config.toml
system2 onboard

# Start the server and open browser
system2 start
```

The `onboard` command walks you through selecting LLM providers, entering API keys, and optionally configuring web search (Brave Search). All settings are written to `~/.system2/config.toml`.

## Configuration

All System2 settings live in a single file: `~/.system2/config.toml`. This file is created during onboarding and has `0600` permissions since it contains API keys. You can edit it directly at any time.

```toml
# LLM providers and API keys
[llm]
primary = "anthropic"
fallback = ["google", "openai"]

[llm.anthropic]
keys = [
  { key = "sk-ant-...", label = "personal" },
  { key = "sk-ant-...", label = "work" },
]

[llm.google]
keys = [
  { key = "AIza...", label = "default" },
]

[llm.openai]
keys = [
  { key = "sk-...", label = "default" },
]

# Service credentials
[services.brave_search]
key = "BSA..."

# Tool settings
[tools.web_search]
enabled = true
max_results = 5

# Operational settings
[backup]
cooldown_hours = 24
max_backups = 5

[session]
rotation_threshold_mb = 10

[logs]
rotation_threshold_mb = 10
max_archives = 5

[scheduler]
daily_summary_interval_minutes = 30

[chat]
max_history_messages = 100
```

### Sections

| Section | Description |
|---------|-------------|
| `[llm]` | Primary provider, fallback order, and API keys per provider. Each provider supports multiple labeled keys for rotation and failover. |
| `[services.*]` | Credentials for external services (e.g., Brave Search). |
| `[tools.*]` | Enable/disable and configure individual tools (e.g., web search). |
| `[backup]` | Automatic backup frequency and retention. |
| `[session]` | Session file rotation threshold. |
| `[logs]` | Log file rotation threshold and archive retention. |
| `[scheduler]` | Narrator job scheduling (daily summary interval). |
| `[chat]` | Chat history settings (max messages to keep). |

### LLM Providers

| Provider | Models |
|----------|--------|
| `anthropic` | Claude (Sonnet, Opus) |
| `google` | Gemini |
| `openai` | GPT, o-series |

### Automatic Failover

When API errors occur, System2 automatically retries and fails over to alternate keys or providers:

| Error | Behavior |
|-------|----------|
| **401/403** (auth) | Immediate failover - key is permanently marked failed |
| **429** (rate limit) | Retry 3x with exponential backoff, then failover |
| **500/503/timeout** | Retry 2x with exponential backoff, then failover |
| **400** (bad request) | Surface error to user (no retry) |

**Failover order:**
1. Try next key for the current provider
2. If no keys remain, try the first fallback provider
3. Continue through fallback providers in order

**Cooldown recovery:** Keys that fail due to rate limits or transient errors enter a 5-minute cooldown and become available again automatically. Auth errors (invalid/revoked keys) are permanent until you update `config.toml`.

### Data Directory

All System2 data lives in `~/.system2/`:

```
~/.system2/
├── .git/               # Version control for text files
├── config.toml         # All settings and credentials (0600 permissions)
├── app.db              # SQLite database (projects, tasks, agents)
├── chat-history.json   # Recent chat messages (server-side, max 100)
├── server.pid          # PID file when server is running
├── knowledge/          # Persistent memory
│   ├── infrastructure.md  # Data stack details (Guide)
│   ├── user.md            # User profile (Guide)
│   ├── memory.md          # Long-term memory (Narrator)
│   └── daily_summaries/   # Daily activity summaries (Narrator)
├── sessions/           # Agent conversation history (JSONL)
├── projects/           # Project workspaces
└── logs/
    ├── system2.log     # Server logs (rotated automatically)
    └── system2.log.N   # Rotated logs (system2.log.1 to system2.log.5)
```

Automatic backups are stored in `~/.system2-auto-backup-<timestamp>/`.

## CLI Reference

The `system2` command manages the server lifecycle.

### Commands

| Command | Description |
|---------|-------------|
| `system2 onboard` | Interactive setup - creates `~/.system2/`, prompts for API keys |
| `system2 start` | Start the server as a background daemon |
| `system2 stop` | Gracefully stop the server |
| `system2 status` | Show server status, PID, and log file size |

### Start Options

```bash
system2 start                  # Default: port 3000, opens browser
system2 start -p 8080          # Custom port
system2 start --no-browser     # Don't open browser
system2 start --foreground     # Run in foreground (logs to stdout)
```

On each start, System2 automatically:
- Creates a backup of `~/.system2/` (once per 24h, keeps last 5)
- Rotates log files if they exceed 10 MB

## Project Structure

```
system2/
├── packages/
│   ├── cli/                    # CLI entry point (commander.js)
│   │   └── src/
│   │       ├── commands/       # start, stop, status, onboard
│   │       └── utils/          # backup, log-rotation, config
│   │
│   ├── server/                 # HTTP/WebSocket server + agent host
│   │   └── src/
│   │       ├── agents/
│   │       │   ├── agents.md   # Shared agent reference (prepended to all system prompts)
│   │       │   ├── library/    # Agent definitions (guide.md, conductor.md, ...)
│   │       │   ├── tools/      # bash, read, write, query-database, message-agent, show-artifact, web-fetch, web-search
│   │       │   ├── host.ts     # AgentHost with failover
│   │       │   ├── registry.ts # AgentRegistry (maps agent IDs to AgentHost instances)
│   │       │   ├── auth-resolver.ts
│   │       │   ├── retry.ts    # Exponential backoff logic
│   │       │   └── session-rotation.ts
│   │       ├── db/
│   │       │   ├── schema.sql  # SQLite schema
│   │       │   └── client.ts   # Database client
│   │       ├── knowledge/      # Knowledge directory init + git
│   │       ├── scheduler/      # Croner-based job scheduler
│   │       └── server.ts       # Express + WebSocket server
│   │
│   ├── shared/                 # Shared TypeScript types
│   │   └── src/
│   │       ├── messages.ts     # WebSocket protocol types
│   │       └── database.ts     # Project, Task, Agent interfaces
│   │
│   └── ui/                     # React chat UI
│       └── src/
│           ├── components/     # Chat, MessageList, MessageInput, ArtifactViewer
│           ├── stores/         # Zustand stores (chat, artifact)
│           ├── hooks/          # useWebSocket (message sending, queue processing)
│           └── theme/          # Centralized color palette
```

## Architecture

System2 is built on [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent), a TypeScript SDK for building LLM-powered coding agents. The SDK provides the core agent loop, tool execution, and session management.

### Multi-Agent System

Agent definitions are stored as Markdown files with YAML frontmatter in `packages/server/src/agents/library/`. A shared reference document (`packages/server/src/agents/agents.md`) is prepended to every agent's system prompt, providing common knowledge about the system, database schema, tools, and inter-agent communication.

| Agent | Role | Models |
|-------|------|--------|
| **Guide** | User-facing agent. Detects system environment, handles questions and simple tasks directly, delegates complex work to Conductor. Populates knowledge files during onboarding. | claude-opus-4.5, gpt-4o, gemini-3.1-pro |
| **Conductor** | Project orchestrator. Reads `plan.md`, breaks work into tasks, creates database schemas and pipeline code, tracks progress in database. | claude-opus-4.5, gpt-4o, gemini-3.1-pro |
| **Narrator** | Memory keeper. Maintains long-term memory and creates daily activity summaries. Singleton (one per system, cross-project). Runs on a schedule. | claude-haiku-4.5, gpt-4o-mini, gemini-2.0-flash |
| **Reviewer** | Validation agent. Checks SQL logic, data transformations, analytical assumptions. Generates validation reports with issues and recommendations. | claude-opus-4.5, gpt-4o, gemini-3.1-pro |

**Agent lifecycle:** Guide and Narrator are singletons — created at server startup, sessions persist indefinitely. Conductor and Reviewer are project-scoped — spawned per project, archived when done.

### System Prompt

LLM APIs are stateless — every API call sends the full system prompt and conversation history. The Pi SDK manages this transparently, persisting history in JSONL files and handling auto-compaction when context limits approach.

Each agent's system prompt is assembled from four layers:

| Layer | Source | Refresh |
|-------|--------|---------|
| Shared reference | `packages/server/src/agents/agents.md` | Once at initialization |
| Agent instructions | `packages/server/src/agents/library/{role}.md` | Once at initialization |
| Knowledge files | `~/.system2/knowledge/` (`infrastructure.md`, `user.md`, `memory.md`) | **Every LLM call** |
| Recent daily summaries | `~/.system2/knowledge/daily_summaries/` (last 2 by filename) | **Every LLM call** |

The static layers (agents.md + role instructions) are loaded once when the agent session is created. Knowledge files and the two most recent daily summaries are read fresh on every API call, so changes made by any agent or the user are reflected immediately without restarting the server. Anthropic's prompt caching makes the static prefix cheap to resend — only the refreshed knowledge portion is reprocessed.

Knowledge files and daily summaries are only included if they have more than 10 lines (to skip empty templates or stub files).

### Agent Tools

Agents interact with the system through custom tools defined in `packages/server/src/agents/tools/`. Each tool is a factory function returning a pi-coding-agent `AgentTool` with typed parameters, description, and an async `execute` method.

| Tool | Description | Conditional |
|------|-------------|-------------|
| `bash` | Execute shell commands (30s timeout, 10MB output buffer) | No |
| `read` | Read file contents (absolute or `~/` paths) | No |
| `write` | Write/create files, auto-creates parent directories | No |
| `query_database` | Query System2 SQLite database (read-only: projects, tasks, agents) | No |
| `message_agent` | Send a message to another agent by database ID | No |
| `show_artifact` | Display HTML file in the UI left panel (path must be within `~/.system2/`) | No |
| `web_fetch` | Fetch a URL and extract readable text content | No |
| `web_search` | Search the web via Brave Search API | Yes — requires `[services.brave_search]` key |

`web_search` is added only when a Brave Search API key exists in config and `[tools.web_search]` is not explicitly disabled.

### Message Delivery

The server can inject messages into an agent's context while it is actively processing, using pi-coding-agent's delivery modes:

| Sender | Receiver | Mode | Behavior |
|--------|----------|------|----------|
| User | Guide | `steer` | Interrupts immediately — user gets priority. Awaits full response. |
| Agent | Agent | `followUp` (default) | Waits for receiver to finish current work, then delivers. |
| Agent | Agent | `steer` (urgent) | Interrupts receiver mid-turn. |
| Scheduler | Agent | `followUp` | System-generated task queued for next available turn. |

`AgentHost` exposes two methods: **`prompt()`** (blocking, creates `user` message, used for User → Guide) and **`deliverMessage()`** (non-blocking, creates `custom_message`, used for Agent → Agent and Scheduler → Agent). The distinction exists because user messages need synchronous streaming back to the UI, while inter-agent messages should not block the sender.

The `AgentRegistry` (`packages/server/src/agents/registry.ts`) maps agent database IDs to active `AgentHost` instances for message routing.

### Session Persistence

Every agent gets its own session directory with JSONL persistence, automatic compaction, and session rotation — all handled by `AgentHost.initialize()`. Conversations are persisted using the [pi-coding-agent session format](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md) with a tree structure (`id`, `parentId`) supporting in-place branching.

When context approaches model limits, the SDK auto-compacts older messages into a summary. When JSONL files exceed 10MB, session rotation creates a new file carrying over the compacted history.

### Database Schema

System2 uses SQLite with WAL mode. Full schema in `packages/server/src/db/schema.sql`.

| Table | Description |
|-------|-------------|
| `project` | Data projects with status, labels, timestamps |
| `agent` | Agent instances with role, project assignment, lifecycle status |
| `task` | Work units with hierarchy (parent), priority, assignee, status |
| `task_link` | Directed relationships between tasks (`blocked_by`, `relates_to`, `duplicates`) |
| `task_comment` | Agent-authored comments on tasks |

### Knowledge & Memory

System2 maintains persistent knowledge in `~/.system2/knowledge/`, git-tracked for change history:

- **`infrastructure.md`** — Data stack details (databases, orchestrator, repos). Populated by the Guide during onboarding, updated as infrastructure evolves.
- **`user.md`** — Facts about the user for personalized assistance. Updated by the Guide.
- **`memory.md`** — Long-term memory. Updated by the Narrator every 24 hours into a coherent document. Has a `## Notes` section where any agent can write important facts; the Narrator consolidates these during updates.
- **`daily_summaries/YYYY-MM-DD.md`** — Daily activity summaries. The scheduler pre-computes all activity data (JSONL session records, database changes) and sends it to the Narrator, which appends narrative summaries every 30 minutes (configurable via `[scheduler] daily_summary_interval_minutes` in config.toml).

The Narrator tracks progress via `last_narrator_update_ts` in YAML frontmatter (on both daily summaries and memory.md). On startup, the server checks if narration is stale and queues a catch-up — this handles laptop sleep/shutdown since the in-process scheduler (croner) does not catch up missed jobs.

## Artifact Display

Agents produce HTML artifacts (dashboards, reports, plots) as files on disk under `~/.system2/`. The Guide agent curates which artifact to display using the `show_artifact` tool. The HTML content never passes through the LLM — only the file path does.

### Live Reload

When the Guide shows an artifact, the server starts an `fs.watch` on the file. Any data agent that modifies the file triggers an immediate reload in the UI — no agent action required. Only one file is watched at a time. Showing a new artifact closes the previous watcher.

### Interactive Dashboards

Artifacts run in a sandboxed iframe (`sandbox="allow-scripts allow-same-origin"`). For dashboards that need database access, a `postMessage` bridge connects the iframe to the server:

```
Iframe → postMessage({ type: 'system2:query', requestId, sql })
  → ArtifactViewer intercepts → fetch('/api/query', { sql })
    → Server executes SELECT against SQLite → returns { rows, count }
  → ArtifactViewer posts back → postMessage({ type: 'system2:query_result', requestId, data })
```

The `/api/query` endpoint only allows `SELECT` queries. The iframe cannot access cookies, storage, or navigate the parent frame due to sandbox restrictions.

## Server & Protocol

### HTTP/WebSocket Server

The server (`packages/server/`) runs Express.js with a WebSocket server on the same port:

- **Default port:** 3000
- **Static files:** Serves React UI from `packages/ui/dist/`
- **`/artifacts`:** Serves HTML artifact files from `~/.system2/` (no-cache headers, dotfiles denied)
- **`/api/query`:** POST endpoint for interactive artifact dashboards (SELECT-only SQL)
- **Database:** SQLite at `~/.system2/app.db`
- **Agent hosts:** Manages Guide and Narrator agent sessions (singletons) with failover support. Runs an in-process scheduler for Narrator curation tasks.

### WebSocket Protocol

**Client → Server:**

| Message | Description |
|---------|-------------|
| `{ type: 'user_message', content: string }` | Send user input to agent |
| `{ type: 'steering_message', content: string }` | Send steering message (inserted ASAP into agent loop) |
| `{ type: 'abort' }` | Cancel current agent execution |

**Server → Client:**

| Message | Description |
|---------|-------------|
| `{ type: 'thinking_chunk', content: string }` | Streaming extended thinking |
| `{ type: 'thinking_end' }` | End of thinking block |
| `{ type: 'assistant_chunk', content: string }` | Streaming response text |
| `{ type: 'assistant_end' }` | End of assistant response |
| `{ type: 'tool_call_start', name: string, input?: string }` | Tool execution starting |
| `{ type: 'tool_call_end', name: string, result: string }` | Tool execution complete |
| `{ type: 'artifact', url: string }` | Display HTML artifact in left panel (also sent on live reload) |
| `{ type: 'context_usage', percent, tokens, contextWindow }` | Context window usage after each turn |
| `{ type: 'ready_for_input' }` | Agent finished, ready for next message |
| `{ type: 'chat_history', messages: ChatMessage[] }` | Sent on connect — recent message history from server |
| `{ type: 'error', message: string }` | Error occurred |

## Web UI

The React web interface (`packages/ui/`) provides a responsive chat experience while the agent is working. Chat history is managed server-side — the server persists messages to `~/.system2/chat-history.json` and sends the full history to the UI on each WebSocket connect. The UI does not use browser storage for messages.

### Tech Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| **React** | 18.2.x | Component framework |
| **Vite** | 5.x | Build tool and dev server |
| **Zustand** | 4.5.x | Lightweight state management |
| **Primer React** | 36.x | GitHub's design system components |
| **react-markdown** | 10.x | Markdown rendering |
| **TypeScript** | 5.x | Type safety |

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Chat Component                        │
│  ┌─────────────────────┐    ┌─────────────────────────────┐ │
│  │    MessageList      │    │      MessageInput           │ │
│  │  - Message history  │    │  - Resizable textarea       │ │
│  │  - Streaming output │    │  - Send/Queue button        │ │
│  │  - BrainLoader      │    │  - Queue indicator          │ │
│  └─────────────────────┘    └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │   useChatStore    │  Zustand store
                    │  - messages[]     │
                    │  - messageQueue[] │
                    │  - isStreaming    │
                    │  - isWaiting...   │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │   useWebSocket    │  React hook
                    │  - sendMessage()  │
                    │  - sendSteering() │
                    │  - abort()        │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │    WebSocket      │  ws://localhost:3000
                    └───────────────────┘
```

### Timeline UI

Messages are displayed in a vertical timeline with colored indicators:

| Element | Color | Description |
|---------|-------|-------------|
| **You** (user) | `#00aaba` (teal) | User messages |
| **Guide** (assistant) | `#ffb444` (orange) | Assistant responses |
| **Tool calls** | `#fd2ef5` (magenta) | Tool execution status |
| **Thinking** | `#8b949e` (gray) | Extended thinking blocks (collapsible) |

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Start development mode
pnpm dev

# Type checking
pnpm typecheck
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style guidelines, and the pull request process.

## License

This project is proprietary software. All rights reserved.
