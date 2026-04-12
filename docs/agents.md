# Multi-Agent System

System2's agents are built on the [pi-coding-agent](https://github.com/badlogic/pi-mono) SDK, which provides the core agent loop, tool execution, and JSONL session persistence. System2 adds multi-agent orchestration, LLM failover, dynamic knowledge injection, and inter-agent messaging.

**Key source files:**
- `packages/server/src/agents/host.ts`: AgentHost class
- `packages/server/src/agents/registry.ts`: AgentRegistry
- `packages/server/src/agents/auth-resolver.ts`: AuthResolver
- `packages/server/src/agents/library/`: agent identity and system instructions (Markdown + YAML frontmatter)
- `packages/server/src/agents/agents.md`: shared reference prepended to all system prompts
- `packages/server/src/skills/loader.ts`: role-based skill filtering (`extractRoles`, `filterByRole`); discovery and XML injection are handled by the pi-coding-agent SDK

## Agent Roles

| Agent | Role | Lifecycle | Models |
| --- | --- | --- | --- |
| **Guide** | Primary user-facing agent. Helps brainstorm and plan, starts projects, interfaces with the multi-agent system, and relays updates. Users may also interact directly with other active agents; Guide mediation is preferred in most cases. | Singleton, persistent | claude-sonnet-4-6, gpt-4o, gemini-2.5-flash |
| **Narrator** | Maintains long-term memory: appends project logs and daily summaries, writes project stories on completion. [Schedule-driven](scheduler.md). | Singleton, persistent | claude-haiku-4-5-20251001, gpt-4o-mini, gemini-2.0-flash |
| **Conductor** | Orchestrates and executes work within a project: breaks it into tasks, spawns specialist agents or executes directly, and coordinates with the Reviewer before reporting completion. | Per-project, ephemeral | claude-sonnet-4-6, gpt-4o, gemini-2.5-flash |
| **Reviewer** | Reviews code before push, assesses data analysis for reasoning fallacies (Kahneman's System 2 lens), and evaluates statistical quality of findings. | Per-project, ephemeral | claude-sonnet-4-6, gpt-4o, gemini-2.5-flash |
| **Worker** | Executes self-contained tasks assigned by a Conductor or Guide. Same execution tools, no orchestration. All instructions via `initial_message`. | Per-project, ephemeral | claude-sonnet-4-6, gpt-4o, gemini-2.5-flash |

**Guide and Narrator** are singletons created at server startup. Their sessions persist indefinitely across restarts.

**Conductor and Reviewer** are project-scoped, spawned by Guide for every project and archived when done. **Workers** are lightweight execution agents spawned by Conductors (or the Guide) for parallel or self-contained tasks. They have the same tools as Conductors except orchestration tools (spawn, terminate, resurrect, trigger_project_story) and cannot modify project-level state. The Guide uses the `spawn_agent` tool to create both simultaneously at project creation time. Spawned agents receive the same spawner callback, so Conductors can spawn additional specialist data agents within their own project. On server restart, all non-archived project-scoped agents are restored automatically. If an agent fails to restore, its status remains `active` in the database, the error is logged, and the Guide is notified so it can investigate.

**Agent status** has two values in the database: `active` (alive, should be restored on restart) and `archived` (terminated, will not be restored). Archived agents can be resurrected by the Guide (any non-singleton) or by a Conductor (agents within their own project) via the `resurrect_agent` tool, which flips the status back to `active` and resumes the session from persisted JSONL. Whether an agent is currently processing work is tracked in memory via `AgentHost.isBusy()`, not in the database.

## Agent Identity and System Instructions

Each agent's identity and system instructions are defined as a Markdown file with YAML frontmatter in `packages/server/src/agents/library/`:

```yaml
---
name: Guide
description: User-facing agent
version: "1.0"
models:
  anthropic: claude-sonnet-4-6
  openai: gpt-4o
  google: gemini-2.5-flash
---
# Guide System Prompt

Instructions for the agent...
```

The `models` map specifies which model to use for each LLM provider.

## System Prompt Construction

Each agent's system prompt is assembled from five layers:

| Layer | Source | Loaded |
| ----- | ------ | ------ |
| Shared reference | `agents/agents.md` | Once at init |
| Agent instructions | `agents/library/{role}.md` (body after frontmatter) | Once at init |
| Knowledge files | `~/.system2/knowledge/` (infrastructure.md, user.md, memory.md) | **Every LLM call** |
| Role-aware context | Project log (`projects/{id}_{name}/log.md`) for project-scoped agents, or last 2 daily summaries for system-wide agents | **Every LLM call** |
| Skills index | Built-in (`agents/skills/`) + user (`~/.system2/skills/`), filtered by role, compiled as XML | **Every LLM call** |

The static layers are concatenated into `staticPrompt`. Knowledge is loaded via `loadKnowledgeContext()`, called from the `systemPromptOverride` callback passed to the Pi SDK's `DefaultResourceLoader`. Skills are wired through the SDK via `additionalSkillPaths` (providing both skill directories) and `skillsOverride` (filtering by agent role). Since the SDK only invokes these callbacks during `reload()` (not on every `prompt()` call), `AgentHost` explicitly calls `resourceLoader.reload()` before each prompt to ensure knowledge files and skills are re-read. This means knowledge and skill updates take effect immediately without server restarts.

Empty files are skipped.

Prompt caching (where supported by the provider) optimizes the static prefix: only the refreshed knowledge portion is reprocessed on each call. See [Knowledge System](knowledge-system.md) for the structure and update semantics of each knowledge file.

## AgentHost (`host.ts`)

`AgentHost` wraps a pi-coding-agent `AgentSession` for a single agent. One instance per active agent. The caller is responsible for creating the agent's database record first and passing the `agentId` to the constructor (singletons via `getOrCreateGuideAgent()`/`getOrCreateNarratorAgent()`, spawned agents via `createAgent()`).

### Initialization

1. Look up the pre-existing agent record from the database (throws if not found)
2. Create session directory (`~/.system2/sessions/{role}_{id}/`)
3. Rotate session file if it exceeds 10MB
4. Load shared reference (`agents.md`) and agent identity/instructions (`library/{role}.md`)
5. Parse YAML frontmatter for model selection
6. Create `DefaultResourceLoader` with `systemPromptOverride` callback and store it for per-prompt reloading
7. Create session via `createAgentSession()` with JSONL persistence, custom tools, and `thinkingLevel: 'high'`
8. Subscribe to session events for error detection, busy state tracking, and listener forwarding

### Methods

| Method | Description |
|--------|-------------|
| `prompt(content, options?)` | Reload knowledge, then send a user message. Blocks until agent finishes. `options.isSteering` inserts ASAP into the agent loop. |
| `deliverMessage(content, details, urgent?)` | Reload knowledge, then send inter-agent message via `sendCustomMessage()`. Returns `Promise<void>` that resolves when the agent finishes processing (on `agent_end`) or rejects on permanent failure. Reload errors are swallowed to avoid dropping messages. Tracked in `pendingDeliveries` for failover replay. |
| `subscribe(listener)` | Listen to all session events. Returns unsubscribe function. |
| `abort()` | Cancel current execution. |
| `getContextUsage()` | Get context window usage stats. |
| `isBusy()` | Whether the agent is currently processing (derived from session events). |
| `getProvider()` | Current LLM provider name. |

### Busy State

`AgentHost` tracks whether the agent is actively processing via an in-memory `busy` flag. This is not stored in the database (it is transient runtime state, not lifecycle state). On server restart, all agents start as not-busy since nothing is processing yet.

- **Set to true** on `message_update` or `tool_execution_start` events (agent is thinking, generating, or running tools)
- **Set to false** in four scenarios:
  - `agent_end` event (normal turn completion)
  - `abort()` called (user cancellation; the SDK may not emit `agent_end` after abort)
  - `reinitializeWithProvider()` (failover tears down the old session, clearing stale busy state before the new session starts)
  - `handlePotentialError()` exhausts all retries and failovers (unrecoverable error, agent has stopped processing)
The `/api/agents` endpoint combines DB agent records with in-memory runtime state (`busy`, `contextPercent`) from each registered AgentHost. The UI polls this endpoint every 2 seconds.

## Message Delivery

Messages flow through two paths depending on whether the sender is the user or another agent:

- **User → Guide → User**: the UI sends a `user_message` over WebSocket. The `WebSocketHandler` calls `agentHost.prompt()`, which blocks while the agent processes. As the agent thinks, generates text, and executes tools, session events stream back through the WebSocket as typed `ServerMessage` chunks. Chat history is captured in a server-side ring buffer (default 1000 messages) and replayed on reconnect, so the UI is stateless. See [WebSocket Protocol](websocket-protocol.md) for the full message format, queuing, multi-tab broadcast, and history capture.
- **Agent → Agent**: agents communicate via `deliverMessage()`, which wraps the Pi SDK's `sendCustomMessage()`. Messages appear as `custom_message` entries in the recipient's session. The Guide relays relevant agent updates to the user as part of its normal response stream.
- **User → non-Guide agent**: the user can message any active agent directly via the UI. When this happens, the system automatically summarizes the exchange and delivers it to the Guide after a short delay, so the Guide stays informed without requiring manual relay.

Two methods for sending messages, chosen based on the sender:

| Method | Creates | Used By | Behavior |
|--------|---------|---------|----------|
| `prompt()` | `user` message | User -> Guide | Blocking. Streams response back to UI via WebSocket. |
| `deliverMessage()` | `custom_message` | Agent -> Agent, Scheduler -> Agent | Returns `Promise<void>`. Scheduler jobs await completion; inter-agent callers fire-and-forget. |

### Delivery Modes

pi-agent-core provides two message queues on each agent session: a **steering queue** (checked after every tool execution) and a **follow-up queue** (checked when the agent has no more work). `sendCustomMessage()` accepts a `deliverAs` option that routes into the appropriate queue.

`AgentHost.deliverMessage()` wraps this, choosing the mode based on urgency:

| Mode       | Behavior                                                   | Used When                                           |
|------------|------------------------------------------------------------|-----------------------------------------------------|
| `steer`    | Interrupts receiver mid-turn (injected between tool calls) | User steering messages, urgent inter-agent messages |
| `followUp` | Waits for current turn to finish, then starts a new turn   | Normal inter-agent messages, scheduler jobs         |

## AgentRegistry (`registry.ts`)

A simple `Map<number, AgentHost>` that maps agent database IDs to active AgentHost instances. Used by the `message_agent` tool to route messages between agents.

## AuthResolver (`auth-resolver.ts`)

Manages API key rotation and multi-provider failover. Providers and API keys are defined in [Configuration](configuration.md).

**Shared state, per-agent provider choice:** one `AuthResolver` instance lives in `server.ts` and is shared by all `AgentHost`s. Key cooldown state is global: if Agent A puts a key in cooldown, Agent B sees it too. But each agent tracks its own `currentProvider` and `currentKeyIndex` independently, and only consults the resolver at failover time or reinitialization. There is no push mechanism: agents discover key failures when they hit errors themselves. The `currentKeyIndex` ensures each agent marks the correct key in cooldown, even when another agent has already rotated the shared key index.

### Key Rotation

Each provider can have multiple labeled API keys. Keys are tried in order. When a key fails, it enters cooldown:
- **Rate limits (429):** 90-second cooldown (covers per-minute quota reset windows)
- **All other errors (400, 401, 403, 5xx, timeout):** 5-minute cooldown (user needs time to take corrective action)

All failures use cooldown (no permanent failures). The system auto-recovers after the cooldown expires, so if the user fixes the issue (adds credits, rotates a key, adjusts permissions), the key becomes available again without a restart.

Cooldowns are set once: if a key is already in cooldown, subsequent failures skip the set to avoid extending the lockout when multiple agents hit the same key at staggered times.

### Failover Order

1. Try next key for the current provider
2. If no keys remain, try the first fallback provider
3. Continue through fallback providers in order

### Error Handling Flow

When `AgentHost` detects an API error in a `message_end` event:

1. Categorize the error (see [retry.ts](#retry-logic))
2. Set `lastTurnErrored = true` synchronously (prevents `agent_end` from clearing pending state). On successful turns, `agent_end` resolves `min(deliverySendCount, pendingDeliveries.length)` promises from the queue and resets the counter. `deliverySendCount` is incremented each time `sendCustomMessage` succeeds in `deliverMessage`, so it tracks how many deliveries were sent in the current turn regardless of whether they entered as the initial prompt or as follow-ups
3. Capture `pendingPrompt` and `pendingDeliveries` synchronously (before any `await`)
4. If retriable: wait with exponential backoff, retry with same provider (re-sends the failed prompt and/or all pending deliveries)
5. If retries exhausted or immediate failover: mark key in cooldown, failover to next provider
6. Reinitialize the session with the new provider (`reinitializeWithProvider()`)
7. Retry the pending prompt and/or replay pending deliveries on the new session
8. If all providers exhausted: `pendingPrompt` is preserved on the `AgentHost`, but all pending delivery promises are rejected and `pendingDeliveries` is cleared; no automatic replay occurs when a provider later comes out of cooldown

Error details are shown as collapsible system messages in the agent chat. The title shows the error type and action taken, and the collapsible body has provider-specific details. Key rotation: "429 rate limited, rotating to next key". Provider switch: "503 server error, switched to anthropic".

### Retry Logic (`retry.ts`)

Exponential backoff with jitter: `min(baseDelay * 2^attempt + jitter, maxDelay)`

Rate limit retries are tuned so that cumulative wait exceeds 60s before failover. This ensures per-minute token quotas (e.g., Google's 1M input tokens/min) have time to reset without unnecessarily switching providers.

| Parameter | Default |
|-----------|---------|
| Base delay | 1000ms |
| Max delay | 90,000ms |
| Jitter | 0-25% of delay |
| Max rate limit retries | 7 |
| Max transient retries | 2 |

| Error Category | Retry | Failover |
|---------------|-------|----------|
| `auth` (401/403) | Never | Immediate |
| `rate_limit` (429) | Up to 7x (~127s cumulative) | After retries exhausted |
| `transient` (500/503/timeout) | Up to 2x | After retries exhausted |
| `context_overflow` (400 with token limit message) | Never | Never (compact and recover) |
| `client` (400) | Never | Immediate |

**Context overflow detection:** `categorizeError()` in `retry.ts` checks the error message _before_ status code classification, so a 400 error that matches a context overflow pattern is categorized as `context_overflow` rather than `client`. Detection uses provider-specific regex patterns:

- Google: `input token count.*exceeds.*maximum` ("The input token count (N) exceeds the maximum number of tokens allowed (N)")
- OpenAI: `maximum context length` ("maximum context length is N tokens, you requested N")
- Anthropic: `prompt is too long.*tokens` ("prompt is too long: N tokens > N maximum")

These patterns are intentionally narrow to avoid false positives on rate-limit errors that also mention "token" or "limit" (e.g., "token per minute limit exceeded"). New providers can be supported by adding a regex to `isContextOverflow()` in `retry.ts`.

**Proactive context check during failover:** before switching to a fallback provider, the system looks up the candidate model's `contextWindow` (from the SDK's model registry) and compares it against the current token count. If the context exceeds the candidate's window, `handleContextOverflow()` runs first to compact the conversation, then failover proceeds. This prevents cryptic failures from providers that return bare status codes without error bodies (e.g., Cerebras returning `400` with no message when context is too large). The check runs in both the normal failover path and the last-resort provider recovery path.

**Context overflow recovery:** this can happen reactively (when the API returns a context overflow error) or proactively (when `compactForProvider()` detects that the context exceeds a failover candidate's window). Recovery is one-shot: the guard is armed on the first overflow and re-arms only after recovery completes (successfully or as a no-op). It does not reset on provider failover or re-initialization, so the guard stays active throughout the entire recovery sequence:

1. Find the last JSONL message entry where `entry.message.usage.input < targetContextWindow * 0.50` (message entries store token usage under `entry.message.usage`). The target context window defaults to the current model's window but can be overridden during cross-provider failover to use the candidate model's smaller window.
2. Truncate the active session file at that point, saving the remainder as a "tail"
3. Reinitialize the session from the truncated file and run `compact()` to reduce context to ~5%
4. Append the tail back and reinitialize again

The 50% split threshold matches the `reserveTokens` auto-compaction setting, leaving headroom for the system prompt, knowledge files, and compaction overhead. The result is a session with a compact summary of the safe history plus the recent tail. The overflow-causing prompt is not retried; the agent resumes naturally on the next interaction. Pending deliveries (scheduled tasks, inter-agent messages) are replayed on the recovered session via `sendCustomMessage`, preserving them for the agent to process. If no split point below the threshold is found, or if the tail is empty, recovery skips the corresponding steps. If recovery fails mid-way after the file has been truncated, the tail is restored to the file as a best-effort safeguard.

Auto-compaction is also configured to fire earlier (at ~50% of the context window via `reserveTokens`, instead of the SDK default of ~98%) to reduce the chance of overflow in the first place. The tight threshold also helps with rate limits: per-minute token quotas tend to be on the same order of magnitude as the context window size, so multiple agents calling in the same minute can exhaust the quota. Keeping context compact reduces per-call token consumption and leaves more headroom for concurrent agents.

**Last-resort provider recovery:** after all normal recovery paths (retry, failover, context overflow) are exhausted, `handlePotentialError` checks if a different provider is available before giving up. This covers cases where an agent is stuck on a dead fallback provider (e.g., Anthropic with $0 credits returning 400 `client` errors) while the primary provider's cooldown has expired. `getNextProvider()` iterates in provider order (primary first), so agents naturally gravitate back to the primary when it becomes available.

## Session Persistence

Agent sessions are persisted as JSONL files in `~/.system2/sessions/{role}_{id}/`. The pi-coding-agent SDK manages:
- **Session format:** tree structure with `id` and `parentId` for in-place branching
- **Auto-compaction:** when context approaches model limits, older messages are summarized
- **Compaction pruning:** long-running agents can set `compaction_depth: N` in their frontmatter. After N auto-compactions, a manual "pruning" compaction runs at 30% context usage. It uses the Nth oldest compaction summary as a baseline to shed stale information, creating a sliding window instead of an ever-growing chain. The compaction counter is persisted to `.compaction-count` in the session directory so it survives restarts.

**Session continuation** (`initialize()`): at startup, system2 finds the newest `.jsonl` file by mtime (`findMostRecentSession()`) and opens it directly via `SessionManager.open()`. This tolerates files that lack a valid session header, which `SessionManager.continueRecent()` would reject and silently replace with a fresh empty session. `continueRecent()` is used only when no `.jsonl` file exists yet (first-time setup).

**Session rotation** (`session-rotation.ts`): when a JSONL file exceeds 10MB at initialization, a new file is created carrying over the compacted history. The old file is renamed to `.jsonl.archived` so it is no longer picked up as a continuation candidate. Rotation only runs on cold start (when no prior session exists in memory), before a `SessionManager` is created. It is skipped during failover re-initialization because the outgoing SDK session still holds an open reference to the file and would recreate it without a header on the next append.

See the [pi-coding-agent session format docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md) for details.

## Agent Lifecycle: Spawn and Terminate

### Spawning

The `spawn_agent` tool creates a new agent with a given role and project assignment. Internally, the server:

1. Creates an agent record in `app.db` (`role`, `project`, `status: 'active'`)
2. Creates a new `AgentHost` with the same LLM config + a recursive spawner (so spawned agents can spawn sub-agents)
3. Initializes the session (`initialize()`)
4. Registers in `AgentRegistry`
5. Delivers the caller's `initial_message` via `deliverMessage()`
6. Returns the new agent's database ID

Permission model:

- Guide may spawn Conductors, Workers, or Reviewers for any project
- Conductors may spawn Conductors, Workers, or Reviewers within their own project only
- Narrator cannot spawn agents (receives no spawner)

### Terminating

The `terminate_agent` tool archives an agent when its work is done:

1. Calls `db.updateAgentStatus(id, 'archived')`
2. Calls `targetHost.abort()` to cancel any in-progress turn
3. Calls `registry.unregister(id)` to remove from active routing

Permission model mirrors spawning. Singleton agents (Guide, Narrator) cannot be terminated.

### Resurrection

The `resurrect_agent` tool brings back an archived agent. Only the Guide may use it. Internally, the server:

1. Validates the target is archived and not a singleton
2. Calls `db.updateAgentStatus(id, 'active')`
3. Creates a new `AgentHost` via `initializeAgentHost()`, which resumes the agent's session from its persisted JSONL history
4. Registers the agent in `AgentRegistry`
5. Delivers the Guide's context message via `deliverMessage()`

If initialization fails, the DB status is rolled back to `archived`.

**Session continuity:** since JSONL session files are preserved through termination (only the in-memory `AgentHost` is torn down), a resurrected agent retains its full conversation history. The Guide's context message should orient the agent about the time gap and the new objectives.

**Project record cleanup:** after resurrection, the Guide must update the project record via `write_system2_db`: clear `end_at` and set status back to `in progress`.

**Project log resumption:** the scheduler determines active projects by checking for non-archived conductors. Once a conductor is resurrected, the next scheduled run automatically resumes project log updates.

**Project story on re-completion:** if `trigger_project_story` is called for a project that already has a `project_story.md`, the Narrator receives a note about the existing story and decides whether to edit or rewrite it.

### Project Lifecycle

```text
User request → Guide creates project in app.db
             → Guide spawns Conductor (spawn_agent)
             → Guide spawns Reviewer (spawn_agent)
             → Guide messages Conductor with Reviewer's agent ID
             → Conductor researches domain (data sources, APIs, volumes)
             → Conductor discusses approach with Guide (questions, options, trade-offs)
             → Guide translates for user, relays answers
             → Conductor builds task hierarchy in app.db
             → Conductor presents plan to Guide (prose summary, task IDs, tech decisions)
             → Guide presents plan to user for approval
             → User approves → Guide tells Conductor to proceed
             → Conductor executes, spawning workers as needed
             → Conductor coordinates Reviewer for analytical sign-off
             → Conductor messages Guide: project complete
             → Guide relays to user, user confirms
             → Guide messages Conductor: "close the project"
             → Conductor resolves remaining tasks, calls trigger_project_story
             → Narrator writes story, messages Conductor
             → Conductor reports to Guide
             → Guide terminates Conductor + Reviewer
             → Guide updates project status to "done"

--- Optional: Project Restart ---
User request → Guide confirms resurrection is the right approach
             → Guide queries archived agents for the project (read_system2_db)
             → Guide resurrects Conductor (resurrect_agent)
             → Guide resurrects Reviewer (resurrect_agent)
             → Guide updates project: clear end_at, status → "in progress"
             → Resurrected agents resume from persisted session history
             → Normal project lifecycle continues from execution phase
```

---

## Work Management via app.db

Every System2 agent (Guide, Conductor, Narrator, Reviewer, and any specialist agent spawned by Conductor) **must** use `app.db` (`~/.system2/app.db`) as the single source of truth for all project and task management. The tools `read_system2_db` and `write_system2_db` are the primary interface. See [database.md](database.md) for the full schema and [tools.md](tools.md) for tool reference.

### Work Assignment Model

**The primary work modality is push, not pull.** The Conductor assigns tasks to agents by setting `assignee` and then messaging them with their task IDs. Agents should always prefer working on tasks they have been explicitly assigned.

**Conductor** is the primary planner. In projects where the Conductor is the sole executor, it self-assigns tasks via `createTask`/`updateTask` and coordinates the Reviewer directly. When specialist agents are active, the Conductor creates tasks, assigns them, and messages each agent its task IDs.

**Guide** and **Narrator** are system-wide singleton roles: they do not belong to a project and are not subject to project-scoped work assignment.

**Pull-based work claiming** via `claimTask` is a secondary mechanism, appropriate only when the Conductor has explicitly set up a pool of unassigned `todo` tasks for an agent to self-schedule, and the task scope matches the agent's scope.

If you have no assigned work and no pull-mode arrangement, **ask the Conductor** what to do next: do not self-assign arbitrarily.

### Mandatory Behaviors

Every agent must:

1. **Check for assigned work** on startup and during idle periods:

   ```sql
   SELECT t.id, t.title, t.status, t.priority, p.name AS project_name
   FROM task t
   JOIN project p ON t.project = p.id
   WHERE t.assignee = <my_agent_id>
     AND t.status IN ('todo', 'in progress')
   ORDER BY t.priority DESC, t.start_at ASC
   ```

   If this returns no rows and you are a project-scoped agent, message the Conductor to ask for next steps.

2. **Keep task status current**: transition `todo` → `in progress` → `review` → `done`. Always set `start_at` when beginning a task and `end_at` when completing it.

3. **Post task comments** for progress updates, decisions, intermediate results, and blockers. Comments are the primary audit trail and inter-agent communication channel.

4. **Populate all available fields** on every create/update:

   - `priority`: actual importance (`low` | `medium` | `high`)
   - `labels`: categorize work (e.g., `["data-extraction", "sql"]`)
   - `start_at` / `end_at`: ISO 8601 timestamps for actual work windows
   - `parent`: link subtasks to their parent task ID
   - `assignee`: always set the responsible agent

5. **Create `task_link` records** to express relationships between tasks:

   - `blocked_by`: this task cannot start until the target is `done`
   - `relates_to`: logically connected but not sequential
   - `duplicates`: marks redundant work for cleanup

6. **Reference IDs in all inter-agent messages**: include project, task, and comment IDs in every `message_agent` call so the recipient can query app.db for context without asking for it to be repeated.

### Conductor: Plan-Approve-Execute Cycle

The Conductor is the primary planner for any project it is assigned to. Every project follows a mandatory research, discuss, plan, approve, execute cycle:

1. **Research**: Read the project from app.db, consult infrastructure.md (already in its system prompt), inspect the data pipeline code repository for existing patterns, and research the problem domain (data sources, APIs, file formats, volumes).
2. **Discuss**: Engage the Guide in a detailed technical back-and-forth to resolve unknowns and align on approach. Present implementation options with concrete trade-offs. Ground technology choices in the existing stack; propose new dependencies only with explicit justification.
3. **Plan**: Build a well-populated task hierarchy in app.db (top-level tasks for phases, subtasks via `parent`, `blocked_by` links for sequencing, `assignee` on every task). Task descriptions must include the technical approach, target infrastructure, and acceptance criteria.
4. **Present**: Send a prose summary to the Guide referencing task IDs: phases, technology decisions, expected outputs, risks.
5. **Approve**: Wait for the Guide to relay explicit user approval. Do not execute until approved. Revise the plan if changes are requested.
6. **Execute**: Work through tasks in dependency order, spawning specialist agents as needed. Message each agent their task IDs after spawning.

**Other agents may adjust the plan** when they discover unexpected complexity. When doing so:

- Post a comment on the affected task explaining the change and reasoning.
- Send a `message_agent` to the Conductor describing the adjustment. The Conductor reviews and decides whether to absorb, restructure, or override.

### Inter-Agent Communication Protocol

| Channel        | Tool                                   | Use for                                                         |
|----------------|----------------------------------------|-----------------------------------------------------------------|
| Direct message | `message_agent`                        | Real-time coordination, urgent updates, plan adjustment notices |
| Task comment   | `write_system2_db` `createTaskComment` | Progress, decisions, results (permanent audit trail)            |

Always include task/project/comment IDs in messages. The recipient can then run a single `read_system2_db` query to get full context.

**Example message from a data agent to Conductor:**

> "Task #42 (Extract LinkedIn data) done. 12,450 rows written to `~/.system2/data/linkedin_raw.csv`. Sparse data in 2024-Q1; details in comment #87 on task #42. Task #43 (Normalize data) is now unblocked per blocked_by link."

---

### Example Workflow: Hierarchical Project with Parallel Execution

**Project**: Analyze LinkedIn campaign performance and produce an insights report.

**Agents**: Guide (singleton), Conductor (project-scoped), Worker-Extract (spawned by Conductor), Worker-Analyze (spawned by Conductor), Reviewer (project-scoped), Narrator (singleton).

#### Phase 1: User Request to Project Creation

1. **User → Guide**: "Analyze our LinkedIn campaigns for the last 6 months."

2. **Guide** creates the project and spawns both Conductor and Reviewer:

   ```text
   write_system2_db: createProject
     name: "LinkedIn Campaign Analysis"
     status: "in progress"
   spawn_agent: role="conductor", project_id=1
   spawn_agent: role="reviewer", project_id=1
   message_agent → Conductor: "Project #1. Goal: 6-month LinkedIn campaign analysis. Consult infrastructure.md for your data stack."
   message_agent → Reviewer: "Project #1. Review Conductor's analytical work on request."
   message_agent → Conductor: "Reviewer is agent #4."
   ```

#### Phase 2: Research, Discussion, and Plan Approval

Conductor reads project #1, consults infrastructure.md, inspects the pipeline repo, and researches the LinkedIn API.

**Conductor → Guide**: "The LinkedIn API returns campaign data in paginated JSON (max 100 per request). I estimate ~50K rows for 6 months. Two approaches: (A) Pull via API directly into TimescaleDB with a Python script following the openetl 4-step pattern, or (B) Export CSVs from the LinkedIn UI and ingest from flat files. Option A is automatable and repeatable but needs API credentials. Option B is faster for a one-off but manual. Which does the user prefer?"

**Guide → User** (translated): "The Conductor found two paths for getting the LinkedIn data. [simplified explanation]. Do you have LinkedIn API credentials, or would you prefer a CSV export?"

**User → Guide**: "I have API credentials. Let's automate it."

**Guide → Conductor**: "User prefers the API approach. Credentials are available."

After alignment, the Conductor creates tasks in app.db:

| Task | Title                        | Parent | Assignee               | Priority |
|------|------------------------------|--------|------------------------|----------|
| #10  | Extract raw LinkedIn data    | —      | Worker-Extract (#5) | high     |
| #11  | Normalize and clean data     | —      | Worker-Extract (#5) | high     |
| #12  | Perform statistical analysis | —      | Worker-Analyze (#6) | high     |
| #13  | Calculate engagement metrics | #12    | Worker-Analyze (#6) | high     |
| #14  | Identify trends over time    | #12    | Worker-Analyze (#6) | medium   |
| #15  | Review analysis quality      | —      | Reviewer (#4)          | high     |
| #16  | Generate insights report     | —      | Worker-Analyze (#6) | high     |

Task links: #11 `blocked_by` #10 → #12 `blocked_by` #11 → #15 `blocked_by` #12 → #16 `blocked_by` #15.

**Conductor → Guide**: "Plan created. 7 tasks across 4 phases (tasks #10-#16). Using LinkedIn API → Python ingestion script → TimescaleDB `lens` database → Airflow DAG for scheduling. Worker-Extract (#5) and Worker-Analyze (#6) will be spawned at execution. No new dependencies needed."

**Guide → User**: "Here's the plan: [summary with phases and tech choices]. Should I tell the Conductor to proceed?"

**User**: "Yes, go ahead."

**Guide → Conductor**: "Plan approved. Proceed with execution."

#### Phase 3: Parallel Execution and Mid-Flight Adjustment

Worker-Extract, Worker-Analyze, and Reviewer work through their tasks in dependency order. When Reviewer finds an error in the engagement rate formula, it sends an urgent message to Conductor. Conductor creates a correction task (#18), notifies Worker-Analyze, and keeps Guide informed. After correction, Reviewer approves.

**Conductor → Guide** (throughout): phase completion messages, blocker alerts, key findings.

**Guide → User**: relays concise synthesis at natural conversation points.

#### Phase 4: Completion and Story

1. Worker-Analyze generates `~/.system2/artifacts/linkedin_report.html`.
2. Conductor messages Guide: "Project #1 complete. Report at artifacts/linkedin_report.html."
3. **Guide → User**: "Project #1 is complete. [Summary]. Shall I finalize this project?"
4. User confirms → Guide messages Conductor: "close the project."
5. Conductor resolves remaining tasks, calls `trigger_project_story` (which creates the story task and delivers pre-computed data to the Narrator).
6. Narrator appends a final project-log entry, then writes the project story. Narrator messages Conductor when done.
7. Conductor reports back to Guide.
8. Guide terminates Conductor (#2) and Reviewer (#4), sets project #1 to `done`.
9. Guide informs user with final summary, artifact location, and story path (`~/.system2/projects/1_linkedin-campaign/project_story.md`).

