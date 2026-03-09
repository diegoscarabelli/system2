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
| **Guide** | User-facing agent. Answers questions, delegates complex work to Conductor. Populates knowledge files. | Singleton, persistent | System-wide | claude-opus-4-6, gpt-4o, gemini-3.1-pro |
| **Conductor** | Project orchestrator. Breaks work into tasks, creates schemas and pipelines, tracks progress. | Per-project, ephemeral | Project-specific | claude-opus-4-6, gpt-4o, gemini-3.1-pro |
| **Narrator** | Memory keeper. Curates project logs and daily summaries, maintains long-term memory, writes project stories. Schedule-driven. | Singleton, persistent | System-wide | claude-haiku-4-5-20251001, gpt-4o-mini, gemini-2.0-flash |
| **Reviewer** | Validation agent. Checks SQL logic, data transformations, analytical assumptions. | Per-project, ephemeral | Project-specific | claude-opus-4-6, gpt-4o, gemini-3.1-pro |

**Guide and Narrator** are singletons created at server startup. Their sessions persist indefinitely across restarts (via `SessionManager.continueRecent()`).

**Conductor and Reviewer** are project-scoped — spawned by Guide for every project, archived when done. The Guide uses the `spawn_agent` tool to create both simultaneously at project creation time. Spawned agents receive the same spawner callback, so Conductors can spawn additional specialist data agents within their own project.

## Agent Definitions

Each agent is defined as a Markdown file with YAML frontmatter in `packages/server/src/agents/library/`:

```yaml
---
name: Guide
description: User-facing agent
version: "1.0"
models:
  anthropic: claude-opus-4-6
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
| Role-aware context | Project log (`projects/{id}/log.md`) for project-scoped agents, or last 2 daily summaries for system-wide agents | **Every LLM call** |

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

- Guide may spawn Conductors or Reviewers for any project
- Conductors may spawn Conductors or Reviewers within their own project only
- Narrator cannot spawn agents (receives no spawner)

### Terminating

The `terminate_agent` tool archives an agent when its work is done:

1. Calls `db.updateAgentStatus(id, 'archived')`
2. Calls `targetHost.abort()` to cancel any in-progress turn
3. Calls `registry.unregister(id)` to remove from active routing

Permission model mirrors spawning. Singleton agents (Guide, Narrator) cannot be terminated.

### Project Lifecycle

```text
User request → Guide creates project in app.db
             → Guide spawns Conductor (spawn_agent)
             → Guide spawns Reviewer (spawn_agent)
             → Guide messages Conductor with Reviewer's agent ID
             → Conductor plans tasks in app.db
             → Conductor executes, spawning data agents as needed
             → Conductor coordinates Reviewer for analytical sign-off
             → Conductor creates "Write project story" task for Narrator
             → Conductor messages Guide: project complete
             → Guide asks user for confirmation
             → User confirms → Guide terminates Conductor + Reviewer
             → Guide updates project status to "done"
```

---

## Work Management via app.db

Every System2 agent — Guide, Conductor, Narrator, Reviewer, and any specialist agent spawned by Conductor — **must** use `app.db` (`~/.system2/app.db`) as the single source of truth for all project and task management. The tools `read_system2_db` and `write_system2_db` are the primary interface. See [database.md](database.md) for the full schema and [tools.md](tools.md) for tool reference.

### Work Assignment Model

**The primary work modality is push, not pull.** The Conductor assigns tasks to agents by setting `assignee` and then messaging them with their task IDs. Agents should always prefer working on tasks they have been explicitly assigned.

**Conductor** is the primary planner. In projects where the Conductor is the sole executor, it self-assigns tasks via `createTask`/`updateTask` and coordinates the Reviewer directly. When specialist agents are active, the Conductor creates tasks, assigns them, and messages each agent its task IDs.

**Guide** and **Narrator** are system-wide singleton roles — they do not belong to a project and are not subject to project-scoped work assignment.

**Pull-based work claiming** via `claimTask` is a secondary mechanism, appropriate only when the Conductor has explicitly set up a pool of unassigned `todo` tasks for an agent to self-schedule, and the task scope matches the agent's scope.

If you have no assigned work and no pull-mode arrangement, **ask the Conductor** what to do next — do not self-assign arbitrarily.

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

### Conductor: Primary Planning Responsibility

The Conductor is the primary planner for any project it is assigned to. Upon receiving a project:

1. Read the project from app.db to understand scope.
2. Break the work into a task hierarchy: top-level tasks for major phases, subtasks (via `parent`) for specific work items.
3. Set `blocked_by` task_links to encode sequencing constraints.
4. Assign tasks to agents by ID (`assignee`), spawn specialist agents as needed.
5. Message each agent their task IDs immediately after creating the plan.
6. Send an initial progress update to Guide: "Plan created for project #N. X tasks across Y phases."

**Other agents may adjust the plan** when they discover unexpected complexity. When doing so:

- Post a comment on the affected task explaining the change and reasoning.
- Send a `message_agent` to the Conductor describing the adjustment. The Conductor reviews and decides whether to absorb, restructure, or override.

### Inter-Agent Communication Protocol

| Channel        | Tool                                   | Use for                                                         |
|----------------|----------------------------------------|-----------------------------------------------------------------|
| Direct message | `message_agent`                        | Real-time coordination, urgent updates, plan adjustment notices |
| Task comment   | `write_system2_db` `createTaskComment` | Progress, decisions, results — permanent audit trail            |

Always include task/project/comment IDs in messages. The recipient can then run a single `read_system2_db` query to get full context.

**Example message from a data agent to Conductor:**

> "Task #42 (Extract LinkedIn data) done. 12,450 rows written to `~/.system2/data/linkedin_raw.csv`. Sparse data in 2024-Q1 — details in comment #87 on task #42. Task #43 (Normalize data) is now unblocked per blocked_by link."

---

### Example Workflow: Hierarchical Project with Parallel Execution

**Project**: Analyze LinkedIn campaign performance and produce an insights report.

**Agents**: Guide (singleton), Conductor (project-scoped), DataAgent-Extract (spawned by Conductor), DataAgent-Analyze (spawned by Conductor), Reviewer (project-scoped), Narrator (singleton).

#### Phase 1 — User Request to Project Creation

1. **User → Guide**: "Analyze our LinkedIn campaigns for the last 6 months."

2. **Guide** creates the project and spawns both Conductor and Reviewer:

   ```text
   write_system2_db: createProject
     name: "LinkedIn Campaign Analysis"
     status: "in progress"
   spawn_agent: role="conductor", project_id=1
   spawn_agent: role="reviewer", project_id=1
   message_agent → Conductor: "Project #1. Reviewer is agent #4. Goal: 6-month campaign analysis."
   message_agent → Reviewer: "Project #1. Review Conductor's analytical work on request."
   ```

#### Phase 2 — Conductor Plans the Task Hierarchy

Conductor reads project #1, creates tasks and dependency links:

| Task | Title                        | Parent | Assignee               | Priority |
|------|------------------------------|--------|------------------------|----------|
| #10  | Extract raw LinkedIn data    | —      | DataAgent-Extract (#5) | high     |
| #11  | Normalize and clean data     | —      | DataAgent-Extract (#5) | high     |
| #12  | Perform statistical analysis | —      | DataAgent-Analyze (#6) | high     |
| #13  | Calculate engagement metrics | #12    | DataAgent-Analyze (#6) | high     |
| #14  | Identify trends over time    | #12    | DataAgent-Analyze (#6) | medium   |
| #15  | Review analysis quality      | —      | Reviewer (#4)          | high     |
| #16  | Generate insights report     | —      | DataAgent-Analyze (#6) | high     |

Task links: #11 `blocked_by` #10 → #12 `blocked_by` #11 → #15 `blocked_by` #12 → #16 `blocked_by` #15.

**Conductor → Guide**: "Plan created. 7 tasks, 4 phases. DataAgent-Extract (#5) and DataAgent-Analyze (#6) spawned. Starting extraction now."

**Guide → User**: "Project underway. Data extraction starts now."

#### Phase 3 — Parallel Execution and Mid-Flight Adjustment

DataAgent-Extract, DataAgent-Analyze, and Reviewer work through their tasks in dependency order. When Reviewer finds an error in the engagement rate formula, it sends an urgent message to Conductor. Conductor creates a correction task (#18), notifies DataAgent-Analyze, and keeps Guide informed. After correction, Reviewer approves.

**Conductor → Guide** (throughout): phase completion messages, blocker alerts, key findings.

**Guide → User**: relays concise synthesis at natural conversation points.

#### Phase 4 — Completion and Story

1. DataAgent-Analyze generates `~/.system2/artifacts/linkedin_report.html`.
2. Conductor creates task "Write project story" assigned to Narrator, messages Narrator with task ID and project details.
3. Conductor messages Guide: "Project #1 complete. Report at artifacts/linkedin_report.html. Story task #17 assigned to Narrator."
4. **Guide → User**: "Project #1 is complete. [Summary]. Shall I finalize this project?"
5. User confirms → Guide terminates Conductor (#2) and Reviewer (#4), sets project #1 to `done`.
6. Guide informs user with final summary, artifact location, and story path (`~/.system2/projects/1/project_story.md`).
7. Narrator (independently) writes the project story by querying app.db, reading project log and session JSONL files.

---

## See Also

- [Tools](tools.md) -- all tools available to agents, including spawn_agent and terminate_agent
- [Knowledge System](knowledge-system.md) -- knowledge files injected into system prompts
- [Database](database.md) -- app.db schema (projects, tasks, agents, task_links, task_comments)
- [Scheduler](scheduler.md) -- how scheduled jobs deliver messages to Narrator
- [Configuration](configuration.md) -- LLM provider and failover configuration
- [WebSocket Protocol](websocket-protocol.md) -- how agent events stream to the UI
