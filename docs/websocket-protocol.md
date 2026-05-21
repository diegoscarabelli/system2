# WebSocket Protocol

The UI communicates with the server over a single WebSocket connection. The server streams agent events in real time.

**Key source files:**

- `src/shared/types/messages.ts`: TypeScript types
- `src/server/websocket/handler.ts`: WebSocketHandler
- `src/ui/hooks/useWebSocket.ts`: client-side hook

## Connection

WebSocket connects to the server port (default 4242). In development, Vite proxies `ws://localhost:3001/ws` to the backend.

On connect, the server sends a `chat_history` message with the Guide agent's recent messages from its per-agent `MessageHistory` (ring buffer, default 1000 messages). The server is the single source of truth for chat history: the UI mirrors `MessageHistory` exactly. Every push to `MessageHistory` is broadcast to subscribed clients as a `chat_message_added` event so the UI's committed-message list never drifts from the server.

## Multi-Agent Routing

The protocol supports multi-agent chat. Each streaming message includes an optional `agentId` field that identifies which agent the message pertains to. When absent, the Guide agent is implied (backward compatibility).

The client tracks an `activeAgentId` (the agent currently displayed in the chat panel). Sending `switch_agent` tells the server to subscribe to a different agent's events and return that agent's chat history.

## Client -> Server

```typescript
type ClientMessage =
  | { type: 'user_message'; content: string; agentId?: number; id?: string }
  | { type: 'steering_message'; content: string; agentId?: number; id?: string }
  | { type: 'abort'; agentId?: number }
  | { type: 'switch_agent'; agentId: number };
```

| Message | Description |
| --- | --- |
| `user_message` | Standard user input. `agentId` targets a specific agent (defaults to active). Optional `id` is reused as the `ChatMessage.id` when the server pushes to `chatCache`, so the echoed `chat_message_added` dedups against the originating tab's optimistic insert. |
| `steering_message` | Priority message inserted ASAP into the agent loop (interrupts current work). Same `id` convention as `user_message`. |
| `abort` | Cancel current agent execution for the specified (or active) agent. |
| `switch_agent` | Switch the active chat to a different agent. Server responds with that agent's `chat_history`, `provider_info`, an `agent_busy_state` snapshot (seeds busy + context usage), and `ready_for_input` (if idle). |

## Server -> Client

```typescript
type ServerMessage =
  | { type: 'thinking_chunk'; content: string; agentId?: number }
  | { type: 'thinking_end'; agentId?: number }
  | { type: 'assistant_chunk'; content: string; agentId?: number }
  | { type: 'assistant_end'; agentId?: number }
  | { type: 'tool_call_start'; name: string; input?: string; agentId?: number }
  | { type: 'tool_call_end'; name: string; result: string; agentId?: number }
  | { type: 'tool_call_progress'; name: string; message: string; agentId?: number }
  | { type: 'artifact'; url: string; title?: string; filePath?: string }
  | { type: 'provider_info'; provider: string; agentId: number }
  | { type: 'provider_change'; provider: string; agentId: number }
  | { type: 'error'; message: string; agentId?: number }
  | { type: 'ready_for_input'; agentId?: number }
  | { type: 'chat_history'; messages: ChatMessage[]; agentId: number }
  | { type: 'chat_message_added'; message: ChatMessage; agentId: number }
  | { type: 'compaction_start'; agentId?: number }
  | { type: 'compaction_end'; agentId?: number }
  // Push notifications for UI panels
  | { type: 'board_changed' }
  | { type: 'agents_changed' }
  | { type: 'artifacts_changed' }
  | { type: 'job_executions_changed' }
  | { type: 'agent_busy_state'; agentId: number; busy: boolean; contextPercent: number | null };
```

| Message | Description |
| --- | --- |
| `thinking_chunk` / `thinking_end` | Streaming extended thinking blocks |
| `assistant_chunk` / `assistant_end` | Streaming response text. `assistant_end` is a stream-over signal; the canonical assistant row (and any LLM-error system row) arrives via `chat_message_added`. |
| `tool_call_start` / `tool_call_end` | Tool execution lifecycle |
| `tool_call_progress` | Heartbeat progress from a long-running tool (e.g., bash `::system2::` sentinel). Carries the progress `message` for UI display. |
| `artifact` | Display artifact in a UI tab. Includes `title` (from DB or filename) and `filePath` (absolute path for tab dedup). Sent when `show_artifact` completes. |
| `provider_info` | Sent on connect/switch: current LLM provider for an agent |
| `provider_change` | Sent on failover: provider switched. Indicator-only — the chat row describing the switch arrives via `chat_message_added` from the server-side `pushSystemMessage` in `reinitializeWithProvider`. |
| `error` | Error message |
| `ready_for_input` | Agent finished, ready for next message |
| `chat_history` | Sent on connect (Guide) and on `switch_agent`: recent messages for the specified agent |
| `chat_message_added` | Fired on every push to the target agent's `chatCache`. Carries the full `ChatMessage`. Every committed chat row — user, assistant, failover system messages, LLM errors, compaction notices — reaches the UI through this single event. UI dedups by `id`. |
| `compaction_start` / `compaction_end` | Auto-compaction lifecycle. UI shows a transient "Compacting..." indicator while in flight; the persisted "Context compacted" / `failed: ...` / `aborted` system row arrives via `chat_message_added`. |
| `board_changed` | Broadcast when `write_system2_db` modifies a project, task, task_link, or task_comment. UI panels refetch `/api/kanban`. |
| `agents_changed` | Broadcast when an agent is spawned, terminated, or resurrected. UI panels refetch `/api/agents`. |
| `artifacts_changed` | Broadcast when `write_system2_db` modifies an artifact. UI panels refetch `/api/artifacts`. |
| `job_executions_changed` | Broadcast when a scheduler job execution is created, completed, failed, or skipped. UI panels refetch `/api/job-executions`. |
| `agent_busy_state` | Broadcast when an agent's busy state changes (message processing start/end). Includes `agentId`, `busy`, and `contextPercent` — single source of truth for context usage in both AgentPane and MessageInput. Also sent unicast on `switch_agent` to seed the new client's view. |

All database writes by agents go through `write_system2_db`, which fires an `onWrite` callback that the server maps to the appropriate push notification. Agents are instructed to never use `bash`/`sqlite3` to modify `app.db`, ensuring all changes are captured. REST endpoints are used for the initial data load on page open. On WebSocket reconnect, the UI clears stale `agentBusy` state (which may have drifted during the disconnect) and bumps all push version counters so every panel refetches from the server.

## Message Flow

### Standard User Message

```text
User types message
  -> UI optimistically adds the user row locally (with a client-generated id)
     when the agent is idle. For steering (mid-stream) the optimistic insert
     is skipped — see "Steering Message" below.
  -> UI sends { type: 'user_message', content, agentId, id }
    -> WebSocketHandler resolves target agent via agentId (default: active)
      -> Pushes user message into agent's chatCache (using the client's id)
        -> chatCache fires its push listener
          -> chat_message_added (carrying the full ChatMessage) is sent to every
             subscribed client. The originating tab dedups against its
             optimistic insert by id; other tabs see the message for the first
             time.
      -> Calls agentHost.prompt(content)
        -> Agent processes (may use tools, think, generate text)
          -> Streaming events flow to clients (all tagged with agentId):
             thinking_chunk* -> thinking_end
             tool_call_start -> tool_call_end (repeated per tool)
             assistant_chunk* -> assistant_end (stream-over signal only)
          -> history-capture finalizes the turn, pushes the assistant message
             (and, on stopReason='error', a "LLM error" system row) into
             chatCache -> chat_message_added carries each row to the UI; the
             draft is cleared atomically with the canonical assistant append.
          -> agent_busy_state (busy=false, broadcast — carries contextPercent)
          -> ready_for_input
```

### Steering Message

```text
User sends steering while agent is working
  -> UI does NOT optimistically insert the user row (skipped when streaming):
     server flushes the in-flight assistant partial BEFORE pushing the user
     row, so a local insert would land the user row before the partial in
     the UI — contradicting the persisted order. Both rows arrive via
     chat_message_added in correct order.
  -> UI sends { type: 'steering_message', content, agentId, id }
    -> WebSocketHandler:
       1. host.flushPartialTurn() — commits whatever the in-flight assistant
          turn has accumulated (thinking + tool calls + text) into chatCache
          first, so the persisted order is [assistant_partial, user_steering]
          rather than racing the SDK's eventual message_end against the
          user-row push. No-op when nothing is in flight. If any tool_calls
          were still running at flush time, their toolName+input is queued
          in history-capture so the later tool_execution_end can be matched
          and recorded as a follow-up assistant row (no data lost).
       2. host.chatCache.push(user message) — echoes back via
          chat_message_added; other tabs see the row for the first time.
       3. agentHost.prompt(content, { isSteering: true })
          -> Pi SDK inserts message ASAP into agent loop, interrupting the
             current turn. The SDK's eventual message_end finds the
             history-capture accumulator empty (already flushed in step 1)
             and is a no-op for the partial-commit branch; the steered turn
             begins.
```

### Agent Switching

```text
User clicks agent in AgentPane
  -> UI updates activeAgentId in chat store (immediate UI switch)
  -> UI sends { type: 'switch_agent', agentId }
    -> WebSocketHandler:
       1. Updates activeAgentId
       2. Subscribes to new agent's events (additive, keeps previous subscriptions)
       3. Sends chat_history (from agent's chatCache)
       4. Sends provider_info
       5. Sends agent_busy_state (unicast snapshot — seeds busy + contextPercent)
       6. Sends ready_for_input (if agent is idle)
  -> UI loadHistory merges committed messages but preserves in-progress streaming state
```

### Steering

Messages sent while an agent is streaming are delivered immediately as `steering_message`, which uses `streamingBehavior: 'steer'` to interrupt the current turn. The interrupt causes the Pi SDK to fire `message_end` for the in-flight turn; `history-capture` finalizes that turn into a persisted assistant message (and, on error, an LLM-error system row), which the UI receives via `chat_message_added`. The new steered turn then begins.

## Artifact postMessage Bridge

HTML artifacts rendered in iframes communicate with the server through a postMessage bridge, separate from the WebSocket channel. This enables interactive dashboards that query databases at runtime.

**Flow:**

```text
Artifact iframe JS
  -> window.parent.postMessage({ type: 'system2:query', requestId, sql, database? })
    -> ArtifactViewer listener in the UI
      -> fetch('POST /api/query', { sql, database })
        -> Server: DatabaseAdapterRegistry routes to the named adapter
          -> Adapter executes SELECT query, returns rows
        <- { rows, count }
      <- postMessage({ type: 'system2:query_result', requestId, rows, count })
    or on error:
      <- postMessage({ type: 'system2:query_error', requestId, error: message })
```

The `database` field selects the connection: omit it or pass `system2` for app.db, or pass the name of an external database from `[databases.<name>]` in config.toml. Only read-only queries are permitted (SELECT, CTEs, EXPLAIN); DML, DDL, and multi-statement queries are rejected with HTTP 403.

This bridge is not part of the WebSocket protocol. It uses standard DOM `postMessage` between the iframe and its parent window, with the UI acting as a relay to the REST endpoint. See [Artifacts](artifacts.md#interactive-dashboards-postmessage-bridge) for the full message format and [Configuration](configuration.md#databases) for database setup.

## Conversation Summarization

When a user directly messages a non-Guide agent, the `ConversationSummarizer` buffers the interaction. After a 1-minute non-resetting timer expires, it generates a concise summary via a one-shot LLM call (using the Narrator's model) and delivers it to the Guide as a follow-up message. This keeps the Guide informed of user-agent interactions without requiring the user to relay information.

## Server Shutdown

On shutdown, the server sends a WebSocket close frame with code `1001` ("Going Away") and reason `"server shutting down"` to every connected client. Clients that don't complete the close handshake within 2 seconds are force-terminated.

## Multi-Tab Support

Multiple browser tabs each open their own WebSocket connection. All tabs receive the same agent events (thinking, text, tool calls) because each handler subscribes independently to the agent.

User messages reach other tabs through the same `chat_message_added` event used for all chat rows: when tab A sends, the server pushes to `chatCache` and every subscribed tab — including tab A — receives the row. The originating tab dedups against its optimistic insert by `id` (the client generates the id and the server reuses it). On reconnect, all tabs receive the full history via `chat_history`.

## History Capture

Each `AgentHost` owns its own `MessageHistory` (chat cache) stored at `~/.system2/sessions/{role}_{id}/chat-cache.json`. `MessageHistory` is observable: every `push()` notifies subscribers, and `WebSocketHandler` subscribes per active agent to forward each push as `chat_message_added`. This single mechanism delivers:

- Assistant turns (and LLM-error system rows) captured by `historyCaptureSubscriber` on `message_end` (registered once in `Server`, not per-handler — duplicate captures would write the row twice).
- User messages captured by `WebSocketHandler.handleClientMessage` (one push per user action; client-generated `id` is reused so the originating tab can dedup).
- Failover system rows pushed by `AgentHost.pushSystemMessage` in `reinitializeWithProvider` (e.g., `"401 auth error, switched to google"` with the `detail` body containing the re-auth hint).
- Compaction system rows pushed by `historyCaptureSubscriber` on `compaction_start` / `compaction_end`.

The invariant: anything visible as a row in the chat lives in `MessageHistory`. The UI's committed-message list mirrors it exactly.

## WebSocketHandler (`handler.ts`)

Each WebSocket connection gets its own `WebSocketHandler` instance. It:

1. Receives `AgentRegistry` and `guideAgentId` in its constructor
2. Sends Guide's `chat_history`, `provider_info`, and an `agent_busy_state` snapshot on connect (the snapshot seeds the client's busy + context usage state)
3. Subscribes to agent events (additive: subscriptions are kept across switches so background agents continue streaming)
4. Converts Pi SDK events to `ServerMessage` types (all tagged with `agentId`):
   - `message_update` (with thinking) -> `thinking_chunk`; transition to text/tool/end -> `thinking_end`
   - `message_update` (with text) -> `assistant_chunk`
   - `message_end` -> `assistant_end` (stream-over signal only; the canonical assistant row and any LLM-error row reach the UI via `chat_message_added`)
   - `tool_execution_start` -> `tool_call_start`
   - `tool_execution_update` (heartbeat only) -> `tool_call_progress`
   - `tool_execution_end` -> `tool_call_end`
   - `agent_end` -> `ready_for_input` (context usage delivery happens via `AgentHost.onBusyChange` -> `agent_busy_state` broadcast)
5. Subscribes to the agent's `chatCache.push` events and forwards each push as `chat_message_added` — single mechanism for delivering user / assistant / system rows to every connected client
6. Captures the user message into the target agent's chatCache (which fires `chat_message_added` to every subscribed client, including this one)
7. Handles `switch_agent` by adding a subscription pair (agent events + chatCache pushes; if not already subscribed) and sending the new agent's state
8. Records non-Guide user messages in the `ConversationSummarizer` for Guide notification
9. Emits `artifact` message when `show_artifact` completes (live reload is handled by UI polling)

## See Also

- [Shared Types](shared.md): TypeScript type definitions
- [UI](ui.md): client-side WebSocket hook and chat store
- [Agents](agents.md): `prompt()` and `deliverMessage()` methods
