# WebSocket Protocol

The UI communicates with the server over a single WebSocket connection. The server streams agent events in real time.

**Key source files:**
- `packages/shared/src/types/messages.ts` -- TypeScript types
- `packages/server/src/websocket/handler.ts` -- WebSocketHandler
- `packages/ui/src/hooks/useWebSocket.ts` -- client-side hook

## Connection

WebSocket connects to the server port (default 3000). In development, Vite proxies `ws://localhost:3001/ws` to the backend.

On connect, the server sends a `chat_history` message with recent messages from `MessageHistory` (ring buffer, default 100 messages). The server is the single source of truth for chat history -- the UI does not persist messages.

## Client -> Server

```typescript
type ClientMessage =
  | { type: 'user_message'; content: string }
  | { type: 'steering_message'; content: string }
  | { type: 'abort' };
```

| Message | Description |
|---------|-------------|
| `user_message` | Standard user input. Queued if agent is busy. |
| `steering_message` | Priority message inserted ASAP into the agent loop (interrupts current work). |
| `abort` | Cancel current agent execution. |

## Server -> Client

```typescript
type ServerMessage =
  | { type: 'thinking_chunk'; content: string }
  | { type: 'thinking_end' }
  | { type: 'assistant_chunk'; content: string }
  | { type: 'assistant_end' }
  | { type: 'tool_call_start'; name: string; input?: string }
  | { type: 'tool_call_end'; name: string; result: string }
  | { type: 'artifact'; url: string }
  | { type: 'context_usage'; percent: number | null; tokens: number | null; contextWindow: number }
  | { type: 'error'; message: string }
  | { type: 'ready_for_input' }
  | { type: 'chat_history'; messages: ChatMessage[] };
```

| Message | Description |
|---------|-------------|
| `thinking_chunk` / `thinking_end` | Streaming extended thinking blocks |
| `assistant_chunk` / `assistant_end` | Streaming response text |
| `tool_call_start` / `tool_call_end` | Tool execution lifecycle |
| `artifact` | Display HTML artifact in UI left panel. Also sent on live reload (file watch). |
| `context_usage` | Context window usage after each agent turn |
| `error` | Error message |
| `ready_for_input` | Agent finished, ready for next message |
| `chat_history` | Sent on connect -- recent messages from server |

## Message Flow

### Standard User Message

```
User types message
  -> UI sends { type: 'user_message', content }
    -> WebSocketHandler calls agentHost.prompt(content)
      -> Agent processes (may use tools, think, generate text)
        -> Events stream back:
           thinking_chunk* -> thinking_end
           tool_call_start -> tool_call_end (repeated per tool)
           assistant_chunk* -> assistant_end
           context_usage
           ready_for_input
```

### Steering Message

```
User sends steering while agent is working
  -> UI sends { type: 'steering_message', content }
    -> WebSocketHandler calls agentHost.prompt(content, { isSteering: true })
      -> Pi SDK inserts message ASAP into agent loop
      -> Agent responds, streaming continues
```

### Message Queuing

The UI maintains a FIFO message queue (`useChatStore.messageQueue`). When the agent is busy:
1. New user messages are appended to the queue
2. Steering messages are prepended (higher priority)
3. On `ready_for_input`, the next queued message is sent automatically

## WebSocketHandler (`handler.ts`)

Each WebSocket connection gets its own `WebSocketHandler` instance. It:

1. Sends chat history on connect
2. Subscribes to agent session events
3. Converts Pi SDK events to `ServerMessage` types:
   - `message_update` (with thinking) -> `thinking_chunk`
   - `message_update` (with text) -> `assistant_chunk`
   - `tool_execution_started` -> `tool_call_start`
   - `tool_execution_ended` -> `tool_call_end`
   - `agent_end` -> `context_usage` + `ready_for_input`
4. Captures completed messages in `MessageHistory`
5. Watches artifact files for live reload (`fs.watch`)

## See Also

- [Shared Types](packages/shared.md) -- TypeScript type definitions
- [UI](packages/ui.md) -- client-side WebSocket hook and chat store
- [Agents](agents.md) -- `prompt()` and `deliverMessage()` methods
