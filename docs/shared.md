# Shared Types

Shared TypeScript type definitions used across the System2 codebase. This directory has no runtime dependencies: it exports only types.

**Source:** `src/shared/`
**Import:** `import { ChatMessage, LlmConfig, ... } from '../shared/types/...'` (relative imports)

## Type Files

### Chat Types (`types/chat.ts`)

Types for chat messages displayed in the UI and persisted by the server.

| Type | Description |
|------|-------------|
| `ChatMessage` | A user or assistant message with optional `turnEvents` |
| `ChatToolCall` | Tool execution record: name, status (`running`/`completed`/`error`), input, result |
| `ChatThinkingBlock` | Extended thinking block with streaming flag |
| `ChatTurnEvent` | Union: `{ type: 'thinking' }` or `{ type: 'tool_call' }` |

### Configuration Types (`types/config.ts`)

Types for `config.toml` and `auth.toml` settings. Used by CLI (config loading) and server (AuthResolver, AgentHost). LLM credentials and service keys live in `auth.toml`; operational knobs live in `config.toml`. See [Configuration](configuration.md) for the file split.

| Type | Description |
|------|-------------|
| `LlmProvider` | `'anthropic' \| 'openai' \| 'google'` |
| `LlmKey` | `{ key: string, label: string }` |
| `LlmConfig` | Primary provider, fallback order, per-provider keys, and optional OAuth tier (sourced from `auth.toml`) |
| `ServicesConfig` | External service credentials, e.g. Brave Search (sourced from `auth.toml`) |
| `ToolsConfig` | Tool feature flags. `web_search.enabled` is sourced from `auth.toml`; `web_search.max_results` is sourced from the top-level `web_search_max_results` scalar in `config.toml` |
| `SchedulerConfig` | `daily_summary_interval_minutes` |
| `ChatConfig` | `max_history_messages` |

### Database Types (`types/database.ts`)

TypeScript interfaces matching the SQLite schema. See [Database](../database.md) for the full schema.

| Type | Description |
|------|-------------|
| `Project` | Data project with status, labels, timestamps |
| `Task` | Work unit with parent hierarchy, priority, assignee |
| `TaskLink` | Directed relationship (`blocked_by`, `relates_to`, `duplicates`) |
| `TaskComment` | Agent-authored comment on a task |
| `Agent` | Agent instance with role, project assignment, lifecycle status |
| `Artifact` | Registered artifact with file path, title, project, tags |

### WebSocket Protocol Types (`types/messages.ts`)

Types for the WebSocket protocol between UI and server. See [WebSocket Protocol](../websocket-protocol.md) for the full specification.

| Type | Description |
|------|-------------|
| `ClientMessage` | Union: `user_message`, `steering_message`, `abort`, `switch_agent` |
| `ServerMessage` | Union: streaming chunks, tool calls, artifacts, context usage, errors, ready signal, chat history, push notifications (`board_changed`, `agents_changed`, `artifacts_changed`, `job_executions_changed`, `agent_busy_changed`) |

## See Also

- [Database](../database.md): schema that these types map to
- [WebSocket Protocol](../websocket-protocol.md): protocol using these message types
- [Configuration](configuration.md): `config.toml` and `auth.toml` structure
