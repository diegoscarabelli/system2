# @system2/ui

React web interface providing a real-time chat experience with artifact display. Chat history is managed server-side -- the UI is stateless and receives history on WebSocket connect.

**Source:** `packages/ui/src/`
**Build:** [Vite](https://vite.dev/) -> `dist/` (static assets)
**Dependencies:** [React 18](https://react.dev/), [Zustand](https://github.com/pmndrs/zustand), [Primer React](https://primer.style/react), [react-markdown](https://github.com/remarkjs/react-markdown)

## Source Structure

```
src/
├── App.tsx                # Root component (ThemeProvider)
├── main.tsx               # React DOM entry
├── index.css              # Global styles
├── components/
│   ├── Layout.tsx         # 2-panel layout (artifact + chat)
│   ├── Chat.tsx           # Chat container (composes MessageList + MessageInput)
│   ├── MessageList.tsx    # Message timeline with streaming
│   ├── MessageInput.tsx   # Auto-growing textarea with queue indicator
│   └── ArtifactViewer.tsx # Sandboxed iframe for HTML artifacts
├── hooks/
│   └── useWebSocket.ts    # WebSocket connection and message handling
├── stores/
│   ├── chat.ts            # Chat state (Zustand)
│   ├── artifact.ts        # Artifact URL state (Zustand)
│   └── theme.ts           # Theme preference (Zustand)
└── theme/
    └── colors.ts          # Color palette constants
```

## Component Architecture

```
App (ThemeProvider)
└── Layout (resizable 2-panel)
    ├── ArtifactViewer (left panel, sandboxed iframe)
    └── Chat (right panel, 33% default width)
        ├── MessageList (scrollable timeline)
        └── MessageInput (textarea + send/stop button)
```

### Layout

Two-panel design with a draggable divider. The artifact panel takes the left side, the chat panel the right (20-60% resizable, default 33%). Header contains logo and light/dark theme toggle.

### MessageList

Displays messages as a vertical timeline with color-coded indicators:

| Element | Color | Description |
|---------|-------|-------------|
| User messages | `#00aaba` (teal) | User input |
| Assistant responses | `#ffb444` (orange) | Agent output (streamed) |
| Tool calls | `#fd2ef5` (magenta) | Collapsible tool execution details |
| Thinking blocks | `#8b949e` (gray) | Collapsible extended thinking |

Each assistant message shows its turn events (thinking -> tool calls -> response text) in chronological order. An animated "brain loader" appears while waiting for a response.

### MessageInput

Auto-growing textarea (1-10 lines, then scrolls). Shows context window usage percentage (turns red above 80%) and queued message count. Toggles between Send and Stop buttons based on streaming state.

### ArtifactViewer

Displays HTML artifacts in a sandboxed iframe (`sandbox="allow-scripts allow-same-origin"`). Supports a `postMessage` bridge for dashboards that need database access:

```
Iframe -> postMessage({ type: 'system2:query', requestId, sql })
  -> ArtifactViewer intercepts -> fetch('/api/query', { sql })
    -> Server executes SELECT -> returns { rows, count }
  -> ArtifactViewer posts back -> postMessage({ type: 'system2:query_result', requestId, data })
```

## State Management

Three [Zustand](https://github.com/pmndrs/zustand) stores with no Redux or Context:

### `useChatStore` (Primary)

| State | Type | Description |
|-------|------|-------------|
| `messages` | `ChatMessage[]` | Full chat history |
| `currentAssistantMessage` | `string` | In-progress streaming text |
| `currentTurnEvents` | `ChatTurnEvent[]` | Thinking + tool calls for current turn |
| `isStreaming` | `boolean` | Currently receiving chunks |
| `isWaitingForResponse` | `boolean` | Sent message, no response yet |
| `messageQueue` | `Array` | FIFO queue (steering messages prepended) |
| `contextPercent` | `number \| null` | Context window usage % |

### `useArtifactStore`

Tracks `currentUrl` with localStorage persistence (`system2:artifact-url`).

### `useThemeStore`

Tracks `colorMode` (light/dark) with localStorage persistence (`system2-theme`). Falls back to system preference.

## WebSocket Hook (`useWebSocket.ts`)

Manages the WebSocket connection to the server:

- Connects to `ws://localhost:3000` (or via Vite proxy in dev)
- On connect: receives `chat_history` from server
- Processes all `ServerMessage` types and updates chat store
- Exposes `sendMessage()`, `sendSteering()`, `abort()`
- On `ready_for_input`: dequeues next message from queue
- Steering messages are prepended to queue (higher priority)

See [WebSocket Protocol](../websocket-protocol.md) for the full message specification.

## Development

In development, Vite runs on port 3001 and proxies to the backend on port 3000:

| Proxy | Target |
|-------|--------|
| `/ws` | `ws://localhost:3000` |
| `/artifacts` | `http://localhost:3000` |
| `/api` | `http://localhost:3000` |

UI changes hot-reload instantly. See [Development](../development.md) for the full workflow.

## See Also

- [WebSocket Protocol](../websocket-protocol.md) -- message types handled by the WebSocket hook
- [Server](server.md) -- backend serving artifacts and handling WebSocket connections
- [Architecture](../architecture.md) -- how the UI fits in the system
