# System2

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D8-orange.svg)](package.json)

A single-user, self-hosted AI multi-agent system for working with data.

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
├── config.toml     # All settings and credentials (0600 permissions)
├── app.db          # SQLite database (projects, tasks, agents)
├── server.pid      # PID file when server is running
├── sessions/       # Agent conversation history (JSONL)
├── projects/       # Project workspaces
└── logs/
    └── system2.log # Server logs (rotated automatically)
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

## Architecture

System2 is built on [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent), a TypeScript SDK for building LLM-powered coding agents. The SDK provides the core agent loop, tool execution, and session management.

### Multi-Agent System

Agent definitions are stored as Markdown files with YAML frontmatter in `packages/server/src/agents/library/`. Each agent has a specific role:

| Agent | Role | Models |
|-------|------|--------|
| **Guide** | User-facing agent. Detects system environment, handles questions and simple tasks directly, delegates complex work to Conductor. | claude-opus-4.5, gpt-4o, gemini-3.1-pro |
| **Conductor** | Project orchestrator. Reads `plan.md`, breaks work into tasks, creates database schemas and pipeline code, tracks progress in database. | claude-opus-4.5, gpt-4o, gemini-3.1-pro |
| **Narrator** | Documentation agent. Reviews completed work and creates `narration.md` files capturing context for future modifications. Read-only. | claude-haiku-4.5, gpt-4o-mini, gemini-2.0-flash |
| **Reviewer** | Validation agent. Checks SQL logic, data transformations, analytical assumptions. Generates validation reports with issues and recommendations. | claude-opus-4.5, gpt-4o, gemini-3.1-pro |

**Agent spawning:** Guide is a singleton (one per system). When complex work is needed, Guide spawns a Conductor for that project. Conductor spawns Narrator when work is complete.

### Session Persistence

Agent conversations are persisted in JSONL files with a tree structure:

```
~/.system2/sessions/
├── guide-{uuid}/           # Guide agent sessions
│   └── 2026-03-02T14-30-00_abc123.jsonl
└── conductor-{uuid}/       # Conductor sessions (per project)
    └── 2026-03-02T15-00-00_def456.jsonl
```

**JSONL format:**
- Each line is a JSON object with `type`, `id`, and optional `parentId`
- Tree structure supports branching when user edits or regenerates responses
- Entry types: `session` (header), `user`, `assistant`, `tool_call`, `tool_result`, `compaction`

**Auto-compaction:** When context approaches model limits, the SDK automatically summarizes older messages. The compaction entry contains:
- `summary`: Condensed conversation history
- `firstKeptEntryId`: Pointer to first preserved entry
- `tokensBefore`: Token count before compaction

**Session rotation:** When JSONL files exceed 10MB:
1. New file created with fresh session header
2. Entries from `firstKeptEntryId` through compaction are copied
3. All post-compaction entries are copied
4. Old file remains archived
5. New file picked up automatically (newer mtime)

### Tools

Agents have access to these tools for interacting with the system:

| Tool | Description | Limits |
|------|-------------|--------|
| `bash` | Execute shell commands | 30s timeout, 10MB output buffer |
| `read` | Read file contents | Absolute or home-relative paths |
| `write` | Write files, create parent directories | Overwrites existing files |
| `query_database` | Query System2 SQLite database | Read access to projects, tasks, agents |

### Database Schema

System2 uses SQLite with WAL mode for concurrent access. Schema in `packages/server/src/db/schema.sql`:

**projects**
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT (UUID) | Primary key |
| name | TEXT | Project name |
| description | TEXT | Project description |
| status | TEXT | `active`, `completed`, `archived` |
| created_at, updated_at | TEXT | ISO timestamps |

**tasks**
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT (UUID) | Primary key |
| project_id | TEXT | Foreign key to projects |
| title | TEXT | Task title |
| status | TEXT | `pending`, `in_progress`, `completed`, `failed` |
| assigned_agent_id | TEXT | Agent working on task |
| artifact_path | TEXT | Path to output artifact |

**agents**
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT (UUID) | Primary key |
| type | TEXT | `guide`, `conductor`, `narrator`, `reviewer` |
| project_id | TEXT | NULL for Guide singleton |
| session_path | TEXT | Path to JSONL session directory |
| status | TEXT | `idle`, `working`, `waiting` |

## Server & Protocol

### HTTP/WebSocket Server

The server (`packages/server/`) runs Express.js with a WebSocket server on the same port:

- **Default port:** 3000
- **Static files:** Serves React UI from `packages/ui/dist/`
- **Database:** SQLite at `~/.system2/app.db`
- **Agent host:** Manages Guide agent session with failover support

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
| `{ type: 'ready_for_input' }` | Agent finished, ready for next message |
| `{ type: 'error', message: string }` | Error occurred |

### Web UI

The React web interface (`packages/ui/`) provides a responsive chat experience while the agent is working.

#### Tech Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| **React** | 18.2.x | Component framework |
| **Vite** | 5.x | Build tool and dev server |
| **Zustand** | 4.5.x | Lightweight state management |
| **Primer React** | 36.x | GitHub's design system components |
| **react-markdown** | 10.x | Markdown rendering |
| **TypeScript** | 5.x | Type safety |

#### Architecture

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

#### State Management

The Zustand store (`useChatStore`) manages all UI state:

| State | Type | Description |
|-------|------|-------------|
| `messages` | `Message[]` | Conversation history (user, assistant, tool) |
| `messageQueue` | `QueuedMessage[]` | Messages waiting to be sent |
| `currentAssistantMessage` | `string \| null` | Streaming response content |
| `currentTurnEvents` | `TurnEvent[]` | Thinking blocks and tool calls for current turn |
| `activeThinkingId` | `string \| null` | Currently streaming thinking block |
| `activeToolCallId` | `string \| null` | Currently executing tool |
| `isStreaming` | `boolean` | True while receiving any response chunks |
| `isWaitingForResponse` | `boolean` | True after send, before first chunk |
| `isConnected` | `boolean` | WebSocket connection status |

**QueuedMessage interface:**
```typescript
interface QueuedMessage {
  id: string;
  content: string;
  isSteering: boolean;  // Priority messages inserted ASAP
  timestamp: number;
}
```

#### WebSocket Hook

The `useWebSocket` hook manages the WebSocket connection and message handling:

- **Connection:** Connects to `ws://{hostname}:3000` on mount
- **Message sending:** `sendMessage()` for regular messages, `sendSteeringMessage()` for priority
- **Queue processing:** `processNextQueuedMessage()` sends next queued message when agent is ready
- **Event handling:** Routes server messages to appropriate store actions

#### Message Flow

1. **User sends message** → `addUserMessage()` adds to history, sets `isWaitingForResponse: true`
2. **WebSocket sends** → `user_message` or `steering_message` to server
3. **Server streams response** → Chunks update `currentAssistantMessage` or `currentTurnEvents`
4. **Response complete** → `assistant_end` triggers `finishAssistantMessage()`
5. **Agent ready** → `ready_for_input` triggers `processNextQueuedMessage()`

#### Message Queueing

Users can continue typing and queueing messages while the agent is processing:

- **Queue button:** When streaming, the Send button changes to "Queue"
- **Queue indicator:** Shows count of queued messages below the input
- **Automatic processing:** Queued messages are sent when `ready_for_input` is received
- **Steering messages:** Priority messages inserted ASAP into the agent loop (via `streamingBehavior: 'steer'` in pi-coding-agent)

```
User sends message → Agent processes → ready_for_input → Next queued message sent
```

#### Loading Indicator

A brain emoji spinner (`BrainLoader` component) appears while waiting for the first response:

- Shows when `isWaitingForResponse` is true and no streaming content exists
- Disappears when the first `thinking_chunk`, `assistant_chunk`, or `tool_call_start` arrives
- Animation: Rotating 🧠 with three dots (•••) appearing sequentially with staggered timing

#### Timeline UI

Messages are displayed in a vertical timeline with colored indicators:

| Element | Color | Description |
|---------|-------|-------------|
| **You** (user) | `#00aaba` (teal) | User messages |
| **Guide** (assistant) | `#ffb444` (orange) | Assistant responses |
| **Tool calls** | `#fd2ef5` (magenta) | Tool execution status |
| **Thinking** | `#8b949e` (gray) | Extended thinking blocks (collapsible) |

### Inter-Agent Communication (Planned)

Custom message types for multi-agent coordination:

| Type | Description |
|------|-------------|
| `agent_spawn` | Parent spawns child agent |
| `agent_message` | Message between agents |
| `agent_result` | Child returns result to parent |

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

### Project Structure

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
│   │       │   ├── library/    # Agent definitions (guide.md, conductor.md, ...)
│   │       │   ├── tools/      # bash, read, write, query-database
│   │       │   ├── host.ts     # AgentHost with failover
│   │       │   ├── auth-resolver.ts
│   │       │   ├── retry.ts    # Exponential backoff logic
│   │       │   └── session-rotation.ts
│   │       ├── db/
│   │       │   ├── schema.sql  # SQLite schema
│   │       │   └── client.ts   # Database client
│   │       └── server.ts       # Express + WebSocket server
│   │
│   ├── shared/                 # Shared TypeScript types
│   │   └── src/
│   │       ├── messages.ts     # WebSocket protocol types
│   │       └── database.ts     # Project, Task, Agent interfaces
│   │
│   └── ui/                     # React chat UI
│       └── src/
│           ├── components/     # Chat, MessageList, MessageInput
│           ├── stores/         # Zustand stores (chat state, message queue)
│           └── hooks/          # useWebSocket (message sending, queue processing)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style guidelines, and the pull request process.

## License

This project is proprietary software. All rights reserved.
