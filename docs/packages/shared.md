# @dscarabelli/shared

Shared TypeScript type definitions used by all other System2 packages. This package has no runtime dependencies: it exports only types.

**Source:** `packages/shared/src/`
**Build:** [tsup](https://tsup.egoist.dev/) -> `dist/index.js`
**Import:** `import { ChatMessage, LlmConfig, ... } from '@dscarabelli/shared'`

## Type Modules

### Chat Types (`types/chat.ts`)

Types for chat messages displayed in the UI and persisted by the server.

| Type | Description |
|------|-------------|
| `ChatMessage` | A user or assistant message with optional `turnEvents` |
| `ChatToolCall` | Tool execution record: name, status (`running`/`completed`/`error`), input, result |
| `ChatThinkingBlock` | Extended thinking block with streaming flag |
| `ChatTurnEvent` | Union: `{ type: 'thinking' }` or `{ type: 'tool_call' }` |

### Configuration Types (`types/config.ts`)

Types for `config.toml` settings. Used by CLI (config loading) and server (AuthResolver, AgentHost).

| Type | Description |
|------|-------------|
| `LlmProvider` | `'anthropic' \| 'openai' \| 'google'` |
| `LlmKey` | `{ key: string, label: string }` |
| `LlmConfig` | Primary provider, fallback order, and per-provider keys |
| `ServicesConfig` | External service credentials (Brave Search) |
| `ToolsConfig` | Tool feature flags (`web_search.enabled`, `web_search.max_results`) |
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
| `ClientMessage` | Union: `user_message`, `steering_message`, `abort` |
| `ServerMessage` | Union: streaming chunks, tool calls, artifacts, context usage, errors, ready signal, chat history |

## See Also

- [Database](../database.md): schema that these types map to
- [WebSocket Protocol](../websocket-protocol.md): protocol using these message types
- [Configuration](../configuration.md): config.toml structure
