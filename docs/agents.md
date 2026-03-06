# Multi-Agent System

System2's agents are built on the [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) SDK, which provides the core agent loop, tool execution, and JSONL session persistence. System2 adds multi-agent orchestration, LLM failover, dynamic knowledge injection, and inter-agent messaging.

**Key source files:**
- `packages/server/src/agents/host.ts` -- AgentHost class
- `packages/server/src/agents/registry.ts` -- AgentRegistry
- `packages/server/src/agents/auth-resolver.ts` -- AuthResolver
- `packages/server/src/agents/library/` -- agent definitions (Markdown + YAML frontmatter)
- `packages/server/src/agents/agents.md` -- shared reference prepended to all system prompts

## Agent Roles

| Agent | Role | Lifecycle | Scope | Models |
|-------|------|-----------|-------|--------|
| **Guide** | User-facing agent. Answers questions, delegates complex work to Conductor. Populates knowledge files. | Singleton, persistent | System-wide | claude-opus-4.5, gpt-4o, gemini-3.1-pro |
| **Conductor** | Project orchestrator. Breaks work into tasks, creates schemas and pipelines, tracks progress. | Per-project, ephemeral | Project-specific | claude-opus-4.5, gpt-4o, gemini-3.1-pro |
| **Narrator** | Memory keeper. Creates daily summaries and maintains long-term memory. Schedule-driven. | Singleton, persistent | System-wide | claude-haiku-4.5, gpt-4o-mini, gemini-2.0-flash |
| **Reviewer** | Validation agent. Checks SQL logic, data transformations, analytical assumptions. | Per-project, ephemeral | Project-specific | claude-opus-4.5, gpt-4o, gemini-3.1-pro |

**Guide and Narrator** are singletons created at server startup. Their sessions persist indefinitely across restarts (via `SessionManager.continueRecent()`).

**Conductor and Reviewer** are project-scoped -- spawned by Guide per project, archived when done.

## Agent Definitions

Each agent is defined as a Markdown file with YAML frontmatter in `packages/server/src/agents/library/`:

```yaml
---
name: Guide
description: User-facing agent
version: "1.0"
models:
  anthropic: claude-opus-4.5
  openai: gpt-4o
  google: gemini-3.1-pro
---
# Guide System Prompt

Instructions for the agent...
```

The `models` map specifies which model to use for each LLM provider.

## System Prompt Construction

Each agent's system prompt is assembled from four layers:

| Layer | Source | Loaded |
|-------|--------|--------|
| Shared reference | `agents/agents.md` | Once at init |
| Agent instructions | `agents/library/{role}.md` (body after frontmatter) | Once at init |
| Knowledge files | `~/.system2/knowledge/` (infrastructure.md, user.md, memory.md) | **Every LLM call** |
| Recent daily summaries | `~/.system2/knowledge/daily_summaries/` (last 2 by filename) | **Every LLM call** |

The static layers are concatenated into `staticPrompt`. The dynamic layers are loaded via `loadKnowledgeContext()`, which is passed as a `systemPromptOverride` callback to the Pi SDK's `DefaultResourceLoader`. This means knowledge updates take effect immediately without server restarts.

Files with 10 or fewer lines are skipped (to ignore empty templates).

Anthropic's prompt caching optimizes the static prefix -- only the refreshed knowledge portion is reprocessed on each call.

## AgentHost (`host.ts`)

`AgentHost` wraps a pi-coding-agent `AgentSession` for a single agent. One instance per active agent.

### Initialization

1. Look up agent record from database
2. Create session directory (`~/.system2/sessions/{role}_{id}/`)
3. Rotate session file if it exceeds 10MB
4. Load shared reference (`agents.md`) and agent definition (`library/{role}.md`)
5. Parse YAML frontmatter for model selection
6. Create `DefaultResourceLoader` with `systemPromptOverride` callback
7. Create session via `createAgentSession()` with JSONL persistence, custom tools, and `thinkingLevel: 'high'`
8. Subscribe to session events for error detection and listener forwarding

### Methods

| Method | Description |
|--------|-------------|
| `prompt(content, options?)` | Send a user message. Blocks until agent finishes. `options.isSteering` inserts ASAP into the agent loop. |
| `deliverMessage(content, details, urgent?)` | Send inter-agent message via `sendCustomMessage()`. Non-blocking. |
| `subscribe(listener)` | Listen to all session events. Returns unsubscribe function. |
| `abort()` | Cancel current execution. |
| `getContextUsage()` | Get context window usage stats. |

## Message Delivery

Two methods for sending messages, chosen based on the sender:

| Method | Creates | Used By | Behavior |
|--------|---------|---------|----------|
| `prompt()` | `user` message | User -> Guide | Blocking. Streams response back to UI via WebSocket. |
| `deliverMessage()` | `custom_message` | Agent -> Agent, Scheduler -> Agent | Non-blocking. Queues for delivery. |

### Delivery Modes

| Mode | Behavior | Used When |
|------|----------|-----------|
| `steer` | Interrupts receiver mid-turn | User steering messages, urgent inter-agent messages |
| `followUp` | Waits for current turn to finish | Normal inter-agent messages, scheduler jobs |

## AgentRegistry (`registry.ts`)

A simple `Map<number, AgentHost>` that maps agent database IDs to active AgentHost instances. Used by the `message_agent` tool to route messages between agents.

## AuthResolver (`auth-resolver.ts`)

Manages API key rotation and multi-provider failover:

### Key Rotation

Each provider can have multiple labeled API keys. Keys are tried in order. When a key fails:
- **Auth errors (401/403):** Key is permanently marked failed
- **Rate limits / transient errors:** Key enters 5-minute cooldown, then becomes available again

### Failover Order

1. Try next key for the current provider
2. If no keys remain, try the first fallback provider
3. Continue through fallback providers in order

### Error Handling Flow

When `AgentHost` detects an API error in a `message_end` event:

1. Categorize the error (see [retry.ts](#retry-logic))
2. If retriable: wait with exponential backoff, retry with same provider
3. If retries exhausted: mark key failed, failover to next provider
4. Reinitialize the session with the new provider (`reinitializeWithProvider()`)
5. Retry the pending prompt

### Retry Logic (`retry.ts`)

Exponential backoff with jitter: `min(baseDelay * 2^attempt + jitter, maxDelay)`

| Parameter | Default |
|-----------|---------|
| Base delay | 1000ms |
| Max delay | 30,000ms |
| Jitter | 0-25% of delay |
| Max rate limit retries | 3 |
| Max transient retries | 2 |

| Error Category | Retry | Failover |
|---------------|-------|----------|
| `auth` (401/403) | Never | Immediate |
| `rate_limit` (429) | Up to 3x | After retries exhausted |
| `transient` (500/503/timeout) | Up to 2x | After retries exhausted |
| `client` (400) | Never | Never (surface error) |

## Session Persistence

Agent sessions are persisted as JSONL files in `~/.system2/sessions/{role}_{id}/`. The pi-coding-agent SDK manages:
- **Session format:** tree structure with `id` and `parentId` for in-place branching
- **Auto-compaction:** when context approaches model limits, older messages are summarized
- **Session continuation:** `SessionManager.continueRecent()` picks up the latest session on restart

**Session rotation** (`session-rotation.ts`): when a JSONL file exceeds 10MB, a new file is created carrying over the compacted history. The old file is archived.

See the [pi-coding-agent session format docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md) for details.

## See Also

- [Tools](tools.md) -- the 8 tools available to agents
- [Knowledge System](knowledge-system.md) -- knowledge files injected into system prompts
- [Scheduler](scheduler.md) -- how scheduled jobs deliver messages to Narrator
- [Configuration](configuration.md) -- LLM provider and failover configuration
- [WebSocket Protocol](websocket-protocol.md) -- how agent events stream to the UI
