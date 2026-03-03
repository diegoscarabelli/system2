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

# Interactive setup (creates ~/.system2/, configures LLM providers)
system2 onboard

# Start the server and open browser
system2 start
```

## Configuration

### LLM Providers

System2 stores credentials in `~/.system2/auth.json`. Run `system2 onboard` to configure interactively, or edit directly:

```json
{
  "version": 1,
  "primary": "anthropic",
  "fallback": ["google", "openai"],
  "providers": {
    "anthropic": {
      "keys": [
        { "key": "sk-ant-...", "label": "personal" },
        { "key": "sk-ant-...", "label": "work" }
      ]
    },
    "google": {
      "keys": [{ "key": "AIza...", "label": "default" }]
    },
    "openai": {
      "keys": [{ "key": "sk-...", "label": "default" }]
    }
  }
}
```

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

**Cooldown recovery:** Keys that fail due to rate limits or transient errors enter a 5-minute cooldown and become available again automatically. Auth errors (invalid/revoked keys) are permanent until you update `auth.json`.

### Data Directory

All System2 data lives in `~/.system2/`:

```
~/.system2/
├── auth.json       # LLM provider credentials (0600 permissions)
├── config.toml     # User settings (backup, session, log rotation)
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
| `{ type: 'error', message: string }` | Error occurred |

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
│           ├── stores/         # Zustand stores (chat, theme)
│           └── hooks/          # useWebSocket
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style guidelines, and the pull request process.

## License

This project is proprietary software. All rights reserved.
