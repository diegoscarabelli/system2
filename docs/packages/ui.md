# @dscarabelli/ui

React web interface providing a real-time chat experience with artifact display. Chat history is managed server-side: the UI is stateless and receives history on WebSocket connect.

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
│   ├── Layout.tsx         # 2-panel layout (artifact + chat) with catalog toggle
│   ├── Chat.tsx           # Chat container (composes MessageList + MessageInput)
│   ├── MessageList.tsx    # Message timeline with streaming
│   ├── MessageInput.tsx   # Auto-growing textarea with steering support
│   ├── ArtifactViewer.tsx    # Tabbed artifact display (iframe + native tabs)
│   ├── AgentPane.tsx          # Active agent list with busy indicators
│   ├── ArtifactCatalog.tsx  # Browsable overlay of all registered artifacts
│   ├── ExecutionHistoryPane.tsx  # Scheduler job execution history panel
│   ├── KanbanBoard.tsx    # Live kanban dashboard (swimlane layout, native tab)
│   ├── TaskDetailModal.tsx # Task detail overlay (comments, links, markdown)
│   ├── ProjectDetailModal.tsx # Project detail overlay (status, labels, dates)
│   ├── MultiSelectDropdown.tsx # Reusable multiselect dropdown with checkboxes
│   └── ParticlesBackground.tsx # Animated particle background (tsparticles)
├── hooks/
│   ├── useWebSocket.ts    # WebSocket connection and message handling
│   └── useAccentColors.ts # Derived accent colors from theme
├── stores/
│   ├── chat.ts            # Chat state (Zustand)
│   ├── artifact.ts        # Artifact tab state (Zustand)
│   └── theme.ts           # Theme preference (Zustand)
└── theme/
    └── colors.ts          # Color palette constants
```

## Component Architecture

```
App (ThemeProvider)
└── Layout (resizable 2-panel)
    ├── ArtifactViewer (left panel, tabbed artifacts + native components)
    │   ├── ParticlesBackground (animated background, toggleable)
    │   ├── ArtifactCatalog (overlay panel, toggled from header)
    │   ├── KanbanBoard (native tab, live task dashboard)
    │   │   ├── TaskDetailModal (overlay, on card click)
    │   │   └── ProjectDetailModal (overlay, on swimlane info icon click)
    │   └── <iframe> (sandboxed, for HTML artifact tabs)
    └── Chat (right panel, 33% default width)
        ├── MessageList (scrollable timeline)
        └── MessageInput (textarea + send/stop button)
```

### Layout

VSCode-style layout with an activity bar on the left edge (48px). The activity bar contains toggle buttons for the artifact catalog, agent pane, kanban board, and execution history (top), plus particles and theme toggles (bottom). Opening the catalog or agents panel closes the other; the kanban board toggles a native tab instead. Opening one side panel closes the other. The artifact viewer fills the center, with the chat panel on the right (20-60% resizable, default 33%). Both the side panel and chat panel have draggable resize handles.

### MessageList

Displays messages as a vertical timeline with color-coded indicators:

| Element | Color | Description |
|---------|-------|-------------|
| User messages | `#00aaba` (teal) | User input |
| Assistant responses | `#ffb444` (orange) | Agent output (streamed) |
| Tool calls | `#fd2ef5` (magenta) | Collapsible tool execution details |
| Thinking blocks | `#8b949e` (gray) | Collapsible extended thinking |
| System messages | `#8b949e` (gray) | Inter-agent messages, scheduled tasks, provider changes |

System messages have two rendering modes based on content format. Messages containing `\n\n` are treated as collapsible: the text before the separator is shown as the header label (e.g., "Conversation: user <-> conductor_7" for summaries, "503 server error, switched to anthropic" for failovers) and the body is rendered as collapsible markdown, collapsed by default. Messages without `\n\n` are displayed as plain muted text under a "System2" header. The server's `deliverMessage()` controls which format is stored in the chat cache (full content for inter-agent messages and summaries, tag-only for scheduled tasks).

Each assistant message shows its turn events (thinking -> tool calls -> response text) in chronological order. An animated "brain loader" appears while waiting for a response and between completed blocks (e.g., after a tool finishes, before the next starts) to indicate the agent is still working.

### MessageInput

Auto-growing textarea (1-10 lines, then scrolls). Shows the current LLM provider name and context window usage percentage (teal below 40%, accent 40-49%, coral at 50%+) in the status bar. Messages sent while the agent is streaming are delivered immediately as steering messages. Toggles between Send and Stop buttons based on streaming state. Provider changes on failover trigger a system message in the chat timeline.

### ArtifactViewer

Tabbed artifact display. Tabs are either **iframe tabs** (sandboxed HTML artifacts) or **native tabs** (React components rendered directly). Tab bar at top shows title and close button for each open artifact; clicking a tab activates it. Empty state shown when no tabs are open.

The only native tab is the Kanban board. Its open/closed state is persisted via `kanbanOpen` in the artifact store, so the board reopens automatically after a page refresh. Only the visibility flag is stored — the tab content is re-rendered fresh on mount.

Supports a `postMessage` bridge for iframe dashboards that need database access:

```
Iframe -> postMessage({ type: 'system2:query', requestId, sql })
  -> ArtifactViewer intercepts -> fetch('/api/query', { sql })
    -> Server executes SELECT -> returns { rows, count }
  -> ArtifactViewer posts back -> postMessage({ type: 'system2:query_result', requestId, data })
```

### ParticlesBackground

Animated particle background rendered behind the artifact panel using [tsparticles](https://particles.js.org/) (`@tsparticles/react` + `@tsparticles/slim`). Toggled via a button in the activity bar; state persisted in `useThemeStore`.

Configuration: 120 particles in accent + teal colors, linked within 150px distance, moving at 0.8 speed with bounce-off-walls and bounce-off-each-other collision. Hover interaction attracts nearby particles. A custom `windowResize` override prevents particle recreation when the container resizes (e.g., dragging the panel divider).

### ArtifactCatalog

Side panel showing all registered artifacts from the database. Polls `GET /api/artifacts` every 2 seconds. Groups artifacts by project (null project shown as "No Project"). Supports text search and project/tag filtering via `MultiSelectDropdown` components (same as KanbanBoard filters). Both project and tags dropdowns include a "None" option for artifacts without a project or tags respectively; inline tag badges use a static accent style (not affected by dropdown selection). Clicking an item opens it as a new tab in ArtifactViewer. Toggled via StackIcon in the activity bar.

### KanbanBoard

Live kanban dashboard showing all tasks grouped by project in a swimlane layout. Toggled via the TasklistIcon button in the activity bar: clicking opens a native tab named "Board" at position 0; clicking again closes it.

Polls `GET /api/kanban` every 2 seconds. On initial load shows a full loading state; subsequent polls update silently without clearing the board.

**Layout:** A shared horizontal scroll container keeps column headers and card grids aligned (minimum 180px per column). Five status columns (Todo, In Progress, Review, Done, Abandoned) with transparent headers (fixed above the vertical scroll area) showing status dot, task count badge, and vertical dividers between columns. Each project is a collapsible swimlane row with transparent header showing project name, info icon button, status badge, completed/total count (done + abandoned = completed), and a segmented progress bar. Done/abandoned projects auto-collapse on first load.

**Cards:** Priority stripe on left edge (coral = high, accent = medium, gray = low), bold title, label chips, and assignee role badge.

**Filters:** Keyword search (with SearchIcon, Primer TextInput, wrapping toolbar), plus four multiselect dropdowns (priority, assignee, labels, status) built with `MultiSelectDropdown`. Each supports checkbox toggling with an "All" toggle that selects/deselects all options. Assignee and labels include a "None" option for tasks without a value; priority does not (all tasks have a priority). The labels dropdown is derived from task labels. The status dropdown controls which columns are visible (projects always remain visible). Dropdown panels cap at `maxHeight: 250px` with scroll for long option lists. Dynamic filters (assignees, labels) are initialized with explicit full sets on first data load; uses `scrollbarGutter: stable` on both column headers and swimlane scroll area to keep vertical dividers aligned.

Clicking a card opens a `TaskDetailModal` overlay for that task. Clicking the info icon on a swimlane header opens a `ProjectDetailModal` overlay for that project.

### TaskDetailModal

Overlay modal showing full task details. Polls `GET /api/tasks/:id` every 2 seconds while open, restarting the poll cycle on navigation to a different task. Uses `AbortController` to cancel in-flight requests when the task ID changes (e.g., clicking a linked task).

**Sections:**

1. Header: task title + close button (X or Escape or backdrop click)
2. Meta: status badge, priority badge, assignee role tag, project name tag, label chips, start/end dates, created/updated timestamps
3. Description rendered as Markdown
4. Task links grouped by relationship type (blocked_by, relates_to, duplicates); clicking a linked task navigates to it
5. Comments timeline: agent role + date header, comment body rendered as Markdown

Scroll position is reset to top whenever the displayed task changes.

### ProjectDetailModal

Overlay modal showing full project details. Receives the project data directly from the kanban state (no additional API call needed, since `GET /api/kanban` already returns all project fields).

**Sections:**

1. Header: project name with ID + close button (X or Escape or backdrop click)
2. Meta: status badge, label chips, start/end dates, created/updated timestamps
3. Description rendered as Markdown

### AgentPane

Side panel showing all non-archived agents with busy/idle indicators. Polls `GET /api/agents` every 2 seconds for agent list, busy state, and context window percentages. Groups agents into "System" (Guide, Narrator) listed first, then by project name. Each agent row shows a teal (`#00aaba`) circle when busy or grey when idle. Toggled via PeopleIcon in the activity bar.

Clicking an agent row switches the chat panel to that agent. The active agent is highlighted with an accent-colored left border on its ID cell. Switching updates `activeAgentId` in the chat store, which triggers the WebSocket hook to send `switch_agent` to the server. The server responds with the agent's chat history and streaming state.

### ExecutionHistoryPane

Side panel showing scheduler job execution history. Polls `GET /api/job-executions` every 2 seconds. Groups executions by job name (daily-summary, memory-update) with collapsible sections. Each row shows a status dot (teal for completed, coral for failed, amber for running), trigger type, start time, and duration. Failed executions are expandable to show the error message. Toggled via HistoryIcon in the activity bar.

## State Management

Three [Zustand](https://github.com/pmndrs/zustand) stores with no Redux or Context:

### `useChatStore` (Primary)

Supports multi-agent chat via per-agent state. Each agent has its own message history and streaming state stored in a `Map<number, PerAgentState>`. The `activeAgentId` determines which agent's state is displayed in the UI. `activeAgentId`, `activeAgentLabel`, and `activeAgentRole` are persisted via the Zustand `persist` middleware (key: `system2:chat-store`) so the selected agent survives page refreshes.

**Global state:**

| State | Type | Description |
|-------|------|-------------|
| `agentStates` | `Map<number, PerAgentState>` | Per-agent chat state keyed by agent DB ID |
| `activeAgentId` | `number \| null` | Currently viewed agent |
| `activeAgentLabel` | `string \| null` | Display label (e.g., `guide_1`, `conductor_3`) |
| `activeAgentRole` | `string \| null` | Capitalized role (e.g., `Guide`, `Conductor`) |
| `guideAgentId` | `number \| null` | Guide agent ID (set on first connect) |
| `isConnected` | `boolean` | WebSocket connection state |
| `provider` | `string \| null` | Current LLM provider (server-global, shared across all agents) |

**Per-agent state (`PerAgentState`):**

| State | Type | Description |
|-------|------|-------------|
| `messages` | `ChatMessage[]` | Full chat history for this agent |
| `currentAssistantMessage` | `string` | In-progress streaming text |
| `currentTurnEvents` | `ChatTurnEvent[]` | Thinking + tool calls for current turn |
| `isStreaming` | `boolean` | Currently receiving chunks |
| `isWaitingForResponse` | `boolean` | Sent message, no response yet |
| `contextPercent` | `number \| null` | Context window usage % |
| `compactionStatus` | `'idle' \| 'compacting' \| 'compacted'` | Auto-compaction state (transient, not persisted) |

Components read the active agent's state via selectors (e.g., `useChatStore(s => s.agentStates.get(s.activeAgentId))`). An exported `EMPTY_AGENT_STATE` constant provides a stable default for selectors when no agent state exists yet.

### `useArtifactStore`

Tab-based artifact state persisted via the Zustand `persist` middleware (key: `system2:artifact-store`). Each `ArtifactTab` has a `type` discriminant: `'iframe'` for sandboxed HTML artifacts, `'native'` for React components rendered directly.

| State | Type | Description |
|-------|------|-------------|
| `tabs` | `ArtifactTab[]` | Open artifact tabs (id, type, url, filePath, title) |
| `activeTabId` | `string \| null` | Currently active tab |
| `catalogOpen` | `boolean` | Whether the catalog panel is visible (not persisted) |
| `agentsOpen` | `boolean` | Whether the agents panel is visible (persisted) |
| `kanbanOpen` | `boolean` | Whether the kanban board tab is open (persisted) |
| `executionsOpen` | `boolean` | Whether the execution history panel is visible (persisted) |

Key behaviors:

- `openArtifact`: if a tab with the same `filePath` exists, activate it and update its URL; otherwise create a new tab
- `closeTab`: remove tab, activate next/previous/null
- `reloadTab`: find tab by `filePath`, update URL (for fs.watch cache-bust reloads)
- `openKanbanTab`: create (or activate existing) native kanban tab at position 0
- `toggleKanbanTab`: close kanban tab if open, otherwise call `openKanbanTab` (used by activity bar button)
- Tab dedup uses `filePath` with cache-bust query params stripped

### `useThemeStore`

Tracks `colorMode` (light/dark) and `particlesEnabled` (boolean) with localStorage persistence (`system2-theme` and `system2-particles` respectively). Color mode falls back to system preference; particles default to enabled.

## WebSocket Hook (`useWebSocket.ts`)

Manages the WebSocket connection to the server with multi-agent routing:

- Connects to `ws://localhost:3000` (or via Vite proxy in dev)
- On connect: receives `chat_history` and `provider_info` for Guide; sets `guideAgentId` and `activeAgentId`
- Routes all incoming `ServerMessage` types to the correct agent's state via `message.agentId` (falls back to `guideAgentId`)
- Exposes `sendMessage()`, `sendSteering()`, `abort()` (all include `activeAgentId`)
- Watches `activeAgentId` changes and sends `switch_agent` to the server when the user switches agents
- On reconnect: re-sends `switch_agent` if the user was viewing a non-Guide agent
- On `ready_for_input`: clears `isStreaming` and `isWaitingForResponse` for that agent
- On `chat_history`: merges committed messages but preserves in-progress streaming state (tool calls, thinking, partial text) for busy agents

See [WebSocket Protocol](../websocket-protocol.md) for the full message specification.

## Development

In development, Vite runs on port 3001 and proxies to the backend on port 3000:

| Proxy | Target |
|-------|--------|
| `/ws` | `ws://localhost:3000` |
| `/api` | `http://localhost:3000` |

UI changes hot-reload instantly. See [Contributing](../../CONTRIBUTING.md) for the full workflow.

## See Also

- [WebSocket Protocol](../websocket-protocol.md): message types handled by the WebSocket hook
- [Server](server.md): backend serving artifacts and handling WebSocket connections
- [Architecture](../architecture.md): how the UI fits in the system
