# WebSocket Protocol

The UI communicates with the server over a single WebSocket connection. The server streams agent events in real time.

**Key source files:**
- `packages/shared/src/types/messages.ts`: TypeScript types
- `packages/server/src/websocket/handler.ts`: WebSocketHandler
- `packages/ui/src/hooks/useWebSocket.ts`: client-side hook

## Connection

WebSocket connects to the server port (default 3000). In development, Vite proxies `ws://localhost:3001/ws` to the backend.

On connect, the server sends a `chat_history` message with the Guide agent's recent messages from its per-agent `MessageHistory` (ring buffer, default 1000 messages). The server is the single source of truth for chat history: the UI does not persist messages.

## Multi-Agent Routing

The protocol supports multi-agent chat. Each streaming message includes an optional `agentId` field that identifies which agent the message pertains to. When absent, the Guide agent is implied (backward compatibility).

The client tracks an `activeAgentId` (the agent currently displayed in the chat panel). Sending `switch_agent` tells the server to subscribe to a different agent's events and return that agent's chat history.

## Client -> Server

```typescript
type ClientMessage =
  | { type: 'user_message'; content: string; agentId?: number }
  | { type: 'steering_message'; content: string; agentId?: number }
  | { type: 'abort'; agentId?: number }
  | { type: 'switch_agent'; agentId: number };
```

| Message | Description |
|---------|-------------|
| `user_message` | Standard user input. `agentId` targets a specific agent (defaults to active). |
| `steering_message` | Priority message inserted ASAP into the agent loop (interrupts current work). |
| `abort` | Cancel current agent execution for the specified (or active) agent. |
| `switch_agent` | Switch the active chat to a different agent. Server responds with that agent's `chat_history`, `context_usage`, and `ready_for_input` (if idle). |

## Server -> Client

```typescript
type ServerMessage =
  | { type: 'thinking_chunk'; content: string; agentId?: number }
  | { type: 'thinking_end'; agentId?: number }
  | { type: 'assistant_chunk'; content: string; agentId?: number }
  | { type: 'assistant_end'; agentId?: number; errorMessage?: string }
  | { type: 'tool_call_start'; name: string; input?: string; agentId?: number }
  | { type: 'tool_call_end'; name: string; result: string; agentId?: number }
  | { type: 'artifact'; url: string; title?: string; filePath?: string }
  | { type: 'context_usage'; percent: number | null; tokens: number | null; contextWindow: number; agentId?: number }
  | { type: 'provider_info'; provider: string; agentId: number }
  | { type: 'provider_change'; provider: string; reason?: string; agentId: number }
  | { type: 'error'; message: string; agentId?: number }
  | { type: 'ready_for_input'; agentId?: number }
  | { type: 'chat_history'; messages: ChatMessage[]; agentId: number }
  | { type: 'user_message_broadcast'; id: string; content: string; timestamp: number; agentId?: number }
  | { type: 'compaction_start'; agentId?: number }
  | { type: 'compaction_end'; agentId?: number };
```

| Message | Description |
|---------|-------------|
| `thinking_chunk` / `thinking_end` | Streaming extended thinking blocks |
| `assistant_chunk` / `assistant_end` | Streaming response text. `assistant_end` carries `errorMessage` when the LLM stop reason was an error; the UI renders it as a collapsible system message in the chat timeline. |
| `tool_call_start` / `tool_call_end` | Tool execution lifecycle |
| `artifact` | Display artifact in a UI tab. Includes `title` (from DB or filename) and `filePath` (absolute path for tab dedup and reload targeting). Also sent on live reload (file watch). |
| `context_usage` | Context window usage after each agent turn |
| `provider_info` | Sent on connect/switch: current LLM provider for an agent |
| `provider_change` | Sent on failover: provider switched. Includes `reason` (e.g., "503 server error, switched to anthropic") and `agentId` so the UI routes the system message to the correct agent chat |
| `error` | Error message |
| `ready_for_input` | Agent finished, ready for next message |
| `chat_history` | Sent on connect (Guide) and on `switch_agent`: recent messages for the specified agent |
| `user_message_broadcast` | User message from another tab, broadcast to all other connected clients |
| `compaction_start` / `compaction_end` | Auto-compaction lifecycle (context window management). UI shows transient "Compacting..." / "Compacted" indicator |

Note: the Board, Catalog, and Agent Pane poll their REST endpoints every 2 seconds rather than relying on push notifications. This ensures the UI reflects database changes regardless of how they were made (tool callbacks, direct sqlite3 access, etc.).

## Message Flow

### Standard User Message

```
User types message
  -> UI sends { type: 'user_message', content, agentId }
    -> WebSocketHandler resolves target agent via agentId (default: active)
      -> Captures user message in agent's chatCache
      -> Broadcasts user_message_broadcast (with agentId) to other tabs
      -> Calls agentHost.prompt(content)
        -> Agent processes (may use tools, think, generate text)
          -> Events stream back (all tagged with agentId):
             thinking_chunk* -> thinking_end
             tool_call_start -> tool_call_end (repeated per tool)
             assistant_chunk* -> assistant_end
             context_usage
             ready_for_input
```

### Steering Message

```
User sends steering while agent is working
  -> UI sends { type: 'steering_message', content, agentId }
    -> WebSocketHandler calls agentHost.prompt(content, { isSteering: true })
      -> Pi SDK inserts message ASAP into agent loop
      -> Agent responds, streaming continues
```

### Agent Switching

```
User clicks agent in AgentPane
  -> UI updates activeAgentId in chat store (immediate UI switch)
  -> UI sends { type: 'switch_agent', agentId }
    -> WebSocketHandler:
       1. Updates activeAgentId
       2. Subscribes to new agent's events (additive, keeps previous subscriptions)
       3. Sends chat_history (from agent's chatCache)
       4. Sends context_usage (if available)
       5. Sends ready_for_input (if agent is idle)
  -> UI loadHistory merges committed messages but preserves in-progress streaming state
```

### Steering

Messages sent while an agent is streaming are delivered immediately as `steering_message`, which uses `streamingBehavior: 'steer'` to interrupt the current turn. The UI commits any in-progress turn events (thinking blocks, tool calls, partial text) as a snapshot message so they remain visible, then adds the user's message below them.

## Conversation Summarization

When a user directly messages a non-Guide agent, the `ConversationSummarizer` buffers the interaction. After a 1-minute non-resetting timer expires, it generates a concise summary via a one-shot LLM call (using the Narrator's model) and delivers it to the Guide as a follow-up message. This keeps the Guide informed of user-agent interactions without requiring the user to relay information.

## Server Shutdown

On shutdown, the server sends a WebSocket close frame with code `1001` ("Going Away") and reason `"server shutting down"` to every connected client. Clients that don't complete the close handshake within 2 seconds are force-terminated.

## Multi-Tab Support

Multiple browser tabs each open their own WebSocket connection. All tabs receive the same agent events (thinking, text, tool calls) because each handler subscribes independently to the agent.

User messages are broadcast to other tabs: when tab A sends a message, the handler sends `user_message_broadcast` (with `agentId`) to all other connected clients so they display the message immediately. The sending tab adds the message locally (optimistic UI). On reconnect, all tabs receive the full history via `chat_history`.

## History Capture

Each `AgentHost` owns its own `MessageHistory` (chat cache) stored at `~/.system2/sessions/{role}_{id}/chat-cache.json`. Assistant message history is captured by a **single subscriber** registered in `Server` per agent (not per-handler), preventing duplicate entries when multiple tabs are open. User messages are captured by the handler that receives them (one per user action).

## WebSocketHandler (`handler.ts`)

Each WebSocket connection gets its own `WebSocketHandler` instance. It:

1. Receives `AgentRegistry` and `guideAgentId` in its constructor
2. Sends Guide's chat history and provider info on connect
3. Subscribes to agent events (additive: subscriptions are kept across switches so background agents continue streaming)
4. Converts Pi SDK events to `ServerMessage` types (all tagged with `agentId`):
   - `message_update` (with thinking) -> `thinking_chunk`; transition to text/tool/end -> `thinking_end`
   - `message_update` (with text) -> `assistant_chunk`
   - `message_end` -> `assistant_end` (with `errorMessage` when `stopReason` is `'error'`)
   - `tool_execution_start` -> `tool_call_start`
   - `tool_execution_end` -> `tool_call_end`
   - `agent_end` -> `context_usage` + `ready_for_input`
5. Captures user messages in the target agent's chat cache and broadcasts to other tabs
6. Handles `switch_agent` by adding a subscription (if not already subscribed) and sending the new agent's state
7. Records non-Guide user messages in the `ConversationSummarizer` for Guide notification
8. Watches artifact files for live reload (`fs.watch`)

## See Also

- [Shared Types](packages/shared.md): TypeScript type definitions
- [UI](packages/ui.md): client-side WebSocket hook and chat store
- [Agents](agents.md): `prompt()` and `deliverMessage()` methods
