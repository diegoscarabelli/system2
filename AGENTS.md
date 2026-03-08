# AGENTS.md

This file provides guidance to AI coding agents working with code in this repository.

## Developer Documentation

The [`docs/`](docs/README.md) directory contains in-depth developer documentation:
- **Architecture**: Monorepo structure, runtime components, pi-coding-agent integration.
- **Packages**: Detailed docs for each package (cli, server, shared, ui).
- **Core Systems**: Agents, tools (`read_system2_db`, `write_system2_db`, and others), database schema, WebSocket protocol, knowledge system, scheduler.
- **Reference**: Configuration (config.toml), development workflow, contributing guide.

## README.md

The [`README.md`](README.md) file contains essential project information:
- **Project overview**: System2 is an AI multi-agent system for working with data.
- **Quickstart**: Installation via npm and basic usage commands.
- **Monorepo structure**: Four packages (cli, server, shared, ui).

## CONTRIBUTING.md

The [`CONTRIBUTING.md`](CONTRIBUTING.md) file contains development guidelines. Key sections:
- **How to Contribute**: Fork-based workflow, branch naming conventions, PR process.
- **Development Setup**: Prerequisites (Node.js >= 18, pnpm >= 8) and setup commands.
- **Building**: Package build order and outputs.
- **Code Quality**: Biome formatting/linting rules and commands.
- **Before Committing**: Required quality checks before every commit.
- **Code Review Process**: How PRs are reviewed and merged.

## Work Management via app.db

Every System2 agent — Guide, Conductor, Narrator, Reviewer, and any data agent spawned by Conductor — **must** use `app.db` (`~/.system2/app.db`) as the single source of truth for all project and task management. The tools `read_system2_db` and `write_system2_db` are the primary interface. See [docs/database.md](docs/database.md) for the full schema and [docs/tools.md](docs/tools.md) for tool reference.

### Work Assignment Model

**The primary work modality is push, not pull.** The Conductor assigns tasks to agents by setting `assignee` and then messaging them with their task IDs. Agents should always prefer working on tasks they have been explicitly assigned.

**Conductor** is the primary planner. In projects where the Conductor is the sole executor, it self-assigns tasks via `createTask`/`updateTask` and coordinates the Reviewer directly. When other specialist agents are active, the Conductor creates tasks, assigns them, and messages each agent its task IDs.

**Guide** and **Narrator** are system-wide singleton roles — they do not belong to a project and are not subject to project-scoped work assignment.

**Pull-based work claiming** via `claimTask` is a secondary mechanism. It is only appropriate when:

- The Conductor has explicitly set up a pool of unassigned `todo` tasks for an agent to self-schedule, **and**
- The task scope matches the agent's scope (`claimTask` enforces this): project-scoped agents can only claim tasks in their own project; project-less agents (Guide, Narrator) can only claim project-less tasks, **and**
- The task is clearly within the agent's stated purpose.

If you have no assigned work and are not in an explicit pull-mode arrangement, **ask the Conductor** what to do next — do not self-assign arbitrarily.

### Mandatory Behaviors

**Every agent must:**

1. **Check for assigned work** on startup and during idle periods:

   ```sql
   SELECT t.id, t.title, t.status, t.priority, p.name AS project_name
   FROM task t
   JOIN project p ON t.project = p.id
   WHERE t.assignee = <my_agent_id>
     AND t.status IN ('todo', 'in progress')
   ORDER BY t.priority DESC, t.start_at ASC
   ```

   If this returns no rows and you are a project-scoped agent (Conductor, Reviewer, or a spawned specialist), message the Conductor to ask for next steps — do not remain idle or self-assign arbitrarily.

2. **Keep task status current**: transition `todo` → `in progress` → `review` → `done`. Always set `start_at` when beginning a task and `end_at` when completing it.

3. **Post task comments** for progress updates, decisions, intermediate results, and blockers. Comments are the primary audit trail and inter-agent communication channel.

4. **Populate all available fields** on every create/update — do not leave fields blank when the value is known:

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

The **Conductor** is the primary planner for any project it is assigned to. Upon receiving a project:

1. Read the project from app.db to understand scope.
2. Break the work into a task hierarchy: top-level tasks for major phases, subtasks (via `parent`) for specific work items.
3. Set `blocked_by` task_links to encode sequencing constraints — nothing should start before its dependencies are done.
4. Assign tasks to agents by ID (`assignee`), spawn specialist agents (data extraction, analysis, etc.) as needed.
5. Message each agent their task IDs immediately after creating the plan.

**Other agents may adjust the plan** when they discover unexpected complexity — splitting a task, adding subtasks, or re-sequencing work. When doing so, the adjusting agent must:

- Post a comment on the affected task explaining the change and reasoning.
- Send a direct `message_agent` to the Conductor describing the adjustment. The Conductor reviews and decides whether to absorb, restructure, or override.

### Inter-Agent Communication Protocol

| Channel        | Tool                                   | Use for                                                           |
|----------------|----------------------------------------|-------------------------------------------------------------------|
| Direct message | `message_agent`                        | Real-time coordination, urgent updates, plan adjustment notices   |
| Task comment   | `write_system2_db` `createTaskComment` | Progress, decisions, results — permanent audit trail              |

Always include task/project/comment IDs in messages. The recipient can then run a single `read_system2_db` query to get full context.

**Example message from a data agent to Conductor:**

> "Task #42 (Extract LinkedIn data) done. 12,450 rows written to `~/.system2/data/linkedin_raw.csv`. Sparse data in 2024-Q1 — details in comment #87 on task #42. Task #43 (Normalize data) is now unblocked per blocked_by link."

---

### Example Workflow: Hierarchical Project with Parallel Execution

**Project**: Analyze LinkedIn campaign performance and produce an insights report.

**Agents**: Guide (singleton), Conductor (project-scoped), DataAgent-Extract (spawned), DataAgent-Analyze (spawned), Reviewer (project-scoped), Narrator (singleton).

#### Phase 1 — User Request to Conductor

1. **User → Guide**: "Analyze our LinkedIn campaigns for the last 6 months and generate a performance report."

2. **Guide** creates the project and spawns Conductor:

   ```text
   write_system2_db: createProject
     name: "LinkedIn Campaign Analysis"
     description: "6-month campaign performance analysis and report"
     status: "in progress"
     labels: ["linkedin", "analytics"]
     start_at: "2026-03-07T10:00:00Z"
   ```

   Project **#1** created. Guide messages Conductor (agent #2): "Project #1 created. Plan and execute the full analysis."

#### Phase 2 — Conductor Plans the Task Hierarchy

Conductor reads project #1, then creates the following tasks and dependency links:

| Task | Title                        | Parent | Assignee               | Priority |
|------|------------------------------|--------|------------------------|----------|
| #10  | Extract raw LinkedIn data    | —      | DataAgent-Extract (#5) | high     |
| #11  | Normalize and clean data     | —      | DataAgent-Extract (#5) | high     |
| #12  | Perform statistical analysis | —      | DataAgent-Analyze (#6) | high     |
| #13  | Calculate engagement metrics | #12    | DataAgent-Analyze (#6) | high     |
| #14  | Identify trends over time    | #12    | DataAgent-Analyze (#6) | medium   |
| #15  | Review analysis quality      | —      | Reviewer (#4)          | high     |
| #16  | Generate insights report     | —      | DataAgent-Analyze (#6) | high     |
| #17  | Summarize findings for user  | —      | Narrator (#3)          | medium   |

Task links: #11 `blocked_by` #10 → #12 `blocked_by` #11 → #15 `blocked_by` #12 → #16 `blocked_by` #15 → #17 `blocked_by` #16.

Conductor messages each agent with their task IDs immediately after creating the plan.

#### Phase 3 — Parallel Execution

1. **DataAgent-Extract** picks up Task #10:
   - Updates #10: `status: "in progress"`, sets `start_at`
   - Queries TimescaleDB via `bash`, extracts 6 months of data
   - Posts comment #30 on #10: "Extracted 12,450 rows. Sparse data in 2024-Q1 — 340 missing values imputed."
   - Updates #10: `status: "done"`, sets `end_at`
   - Picks up #11 (now unblocked): normalizes data, writes `~/.system2/data/linkedin_clean.parquet`
   - Posts comment #31 on #11: "Cleaned to 11,890 rows (4.5% removed: duplicates and zero-spend records)."
   - Updates #11: `status: "done"`, sets `end_at`
   - Messages Conductor: "Tasks #10 and #11 done. Task #12 is now unblocked."

2. **DataAgent-Analyze** detects #12 is unblocked via `read_system2_db`, picks it up:
   - Updates #12: `status: "in progress"`, sets `start_at`
   - Works subtasks #13 and #14, posting comments as analysis runs
   - Updates #12: `status: "done"`, sets `end_at`
   - Messages Conductor: "Task #12 done. Reviewer's task #15 is now unblocked."

3. **Reviewer** detects #15 is unblocked, picks it up:
   - Reads comments on #12–#14 to understand methodology
   - Finds a problem: engagement rate formula is wrong for video campaigns
   - Posts comment #45 on #15: "Engagement rate wrong — should use video_views not clicks. Requires re-analysis."
   - Sends **urgent** `message_agent` to Conductor: "Task #15 blocked by analysis error. See comment #45 on task #15."

4. **Conductor** adjusts plan:
   - Creates Task #18: "Fix video campaign engagement rate" (`parent: 12`, `assignee: DataAgent-Analyze #6`, `priority: high`)
   - Posts comment on #15: "Acknowledged. Task #18 created. Task #15 stays in review until #18 is done."
   - Messages DataAgent-Analyze: "New task #18 under #12 — fix video engagement rate per comment #45 on task #15."

5. **DataAgent-Analyze** picks up #18, corrects formula, re-runs affected calculations:
   - Posts comment on #18: "Fixed. video_views now used as numerator. Results updated."
   - Updates #18: `status: "done"`
   - Messages Reviewer: "Task #18 done. Task #15 is ready for re-review."

6. **Reviewer** re-reviews, approves:
   - Posts comment on #15: "Analysis approved after fix. Methodology sound."
   - Updates #15: `status: "done"`
   - Messages Conductor: "Task #15 approved."

#### Phase 4 — Report and Summary

1. **DataAgent-Analyze** detects #16 is unblocked, generates `~/.system2/artifacts/linkedin_report.html`, calls `show_artifact`, updates #16: `status: "done"`.

2. **Narrator** detects #17 is unblocked, reads all project #1 comments via `read_system2_db`, writes daily summary, updates #17: `status: "done"`. Messages Guide: "Project #1 complete. Report is live in artifact panel."

3. **Conductor** confirms all tasks done, updates Project #1: `status: "done"`, `end_at` now. Messages Guide: "Project #1 wrapped up."

4. **Guide** informs the user that the report is ready.

---

## Command Reference

```bash
pnpm install              # Install dependencies
pnpm build                # Build all packages
pnpm dev                  # Run all packages in dev mode
pnpm check                # Run format check and lint
pnpm format               # Auto-fix formatting
pnpm typecheck            # Run TypeScript type checking
```

Build individual packages:
```bash
pnpm --filter @system2/server build
pnpm --filter @system2/cli build
```

## Before Committing

**MANDATORY**: Run quality checks before every commit:

```bash
pnpm check                # Verify formatting and lint
pnpm build                # Ensure build passes
```

If `pnpm check` reports issues:
```bash
pnpm format               # Auto-fix formatting issues
```

Do not commit code that fails these checks.
