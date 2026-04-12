# System2

**Not a chatbot. A self-hosted AI data team that does the work.**

System2 is a multi-agent system specialized in data engineering, data analysis, and analytical reasoning. It handles the full data lifecycle (procurement, transformation, loading, analysis, reporting) and manages the underlying machinery of your stack (pipelines, databases, orchestrators). You describe a data goal in plain language. System2 spawns a team of AI agents that research the domain, plan the approach, build pipelines, run analyses, review results for statistical fallacies, and produce traceable reports. You stay in the loop without managing the details.

The agents collectively constitute the system: they manage projects together, learn about your infrastructure over time, and take initiative on your behalf. There are no chat sessions. A dedicated Narrator agent runs on a schedule to curate long-term memory, write daily summaries, and produce journalistic project stories. Every interaction builds on the last. System2 is not a tool you restart; it is a team member that remembers.

<!-- TODO: screenshot/GIF of the full UI: chat panel on the right, artifact viewer with a dashboard on the left, activity bar visible -->

---

## Key capabilities

**Knowledge capture and transfer.** Git-tracked markdown files about your infrastructure, preferences, and lessons learned, re-read on every LLM call. Each agent role maintains its own knowledge file. Edits take effect immediately; agents improve over time without code changes.

**Scheduled memory curation.** The Narrator runs on a cron schedule: every 30 minutes it synthesizes agent activity into project logs and daily summaries. Once a day it consolidates learnings into long-term memory. On project completion, it writes a narrative story of the full arc.

**Inter-agent communication.** Direct messages for real-time coordination (with urgent interrupts) and task comments for the permanent audit trail. Agents steer each other, push back on flawed methodology, and relay decisions to you through the Guide.

**Autonomous project management.** Tasks with hierarchy, dependencies, priority, and status tracking in SQLite. The Conductor decomposes work, assigns tasks, and coordinates reviews. You watch progress on a live kanban board.

**Statistical rigor.** A dedicated Reviewer checks every analytical output: sample sizes, effect sizes, causal claims, multiple comparisons. Nothing ships without sign-off.

**Plan-approve-execute.** The Conductor researches, presents a plan, and waits for your approval. Mid-project changes surface back for re-approval.

**Skills framework.** Reusable workflow instructions loaded on demand, filtered by role. Agents create new skills when they recognize reusable patterns.

**Interactive artifacts.** HTML dashboards in sandboxed iframes with live reload. A postMessage bridge provides read-only SQL access to the System2 database.

**Multi-provider LLM failover.** Automatic key rotation and provider failover with exponential backoff across Anthropic, Google, OpenAI, Cerebras, Mistral, OpenRouter, Groq, xAI, and any OpenAI-compatible endpoint.

### How System2 compares

|  | System2 | Anton | CrewAI | MetaGPT | Agor |
| --- | --- | --- | --- | --- | --- |
| **Domain** | Data engineering + analytics | Business intelligence | General purpose | Software engineering | Software engineering |
| **Agent model** | 4-role team (Guide, Conductor, Reviewer, Narrator) | Single agent | Configurable crew | Role-playing software company | Canvas + coding agents |
| **Persistent knowledge** | Git-tracked markdown, auto-curated by Narrator | JSONL episodic memory | Basic config-level | Shared message pool | Per-session only |
| **Project management** | Full (tasks, hierarchy, dependencies, kanban) | No | No | Phase-based SOPs | GitHub issue linking |
| **Statistical review** | Dedicated Reviewer agent | No | No | No | No |
| **Scheduled maintenance** | Narrator cron jobs (summaries, memory, stories) | No | No | No | No |
| **Skills / reusable workflows** | Role-gated, agent-authored | No | No | SOPs | Workflow zones |
| **Interactive artifacts** | HTML dashboards + DB bridge | Charts and dashboards | No | No | No |
| **Self-hosted** | Yes | Yes | Yes (Python library) | Yes (Python library) | Yes |
| **UI** | Full workspace (chat, kanban, artifacts, agents) | Chat + charts | No (Enterprise only) | No | Spatial canvas |

[Anton](https://github.com/mindsdb/anton) (MindsDB): self-hosted autonomous BI agent. Closest direct competitor, but single-agent with no project management, statistical review, or scheduled memory curation. [CrewAI](https://github.com/crewAIInc/crewAI): popular Python framework for role-based agent crews. A building block, not a finished product. [MetaGPT](https://github.com/FoundationAgents/MetaGPT): multi-agent framework simulating a software company. Similar "virtual team" concept but targets software development. [Agor](https://github.com/preset-io/agor): multiplayer spatial canvas for orchestrating coding agents in parallel. Multi-agent UI for software engineering, not data work.

---

## Quick start

> System2 is not yet published to npm. Clone and build from source: see [CONTRIBUTING.md](CONTRIBUTING.md).

**Requirements:** Node.js 20+, pnpm 8+, at least one LLM API key (Anthropic, Google, or OpenAI). Runs on macOS, Linux, and Windows.

```bash
# After building from source:
system2 onboard   # interactive setup: API keys, LLM providers, config.toml
system2 start     # starts server on port 3000 and opens the browser
```

```bash
system2 status    # check if the server is running
system2 stop      # graceful shutdown
```

---

## See it in action

A walkthrough of a real project: building a health and fitness pipeline from a smartwatch API, orchestrated by Prefect, stored in TimescaleDB, with an analytical dashboard at the end.

<!-- TODO: short video (2-3 min) or annotated GIF showing this full flow end-to-end -->

### 1. You describe the goal

```text
You:    I want to track my health data from my Garmin watch. Set up a daily
        pipeline that pulls sleep, heart rate, and activity data into
        TimescaleDB, orchestrated by Prefect. Then analyze the last 3 months
        and build me a dashboard.

Guide:  A few questions first. Are you using the Garmin Connect API directly
        or the garminconnect Python library? Where is TimescaleDB running,
        and is Prefect already deployed or do we need to set it up?

You:    garminconnect library. TimescaleDB is on DiegoTower, Prefect is
        running locally. Credentials are in .env.

Guide:  Got it. Creating the project now. Conductor and Reviewer are
        spinning up.
```

The Guide is your only point of contact. It translates between you and the technical work, creates projects, and spawns the agents that do the execution.

<!-- TODO: screenshot of the chat panel showing this conversation, with the agent pane on the left showing Guide (idle), Conductor (busy), Reviewer (idle) -->

### 2. The Conductor researches and plans

Behind the scenes, the Conductor reads your `infrastructure.md` (to understand your stack), inspects your existing pipeline code for patterns, and investigates the Garmin Connect library's capabilities and rate limits. It messages the Guide with its findings and proposed approach:

```text
Conductor → Guide:  Garmin Connect provides daily summaries for sleep,
                     heart rate, and activities. Rate limits are soft but
                     I'll add backoff. Recommending three hypertables in
                     TimescaleDB (garmin_sleep, garmin_heart_rate,
                     garmin_activities) with 7-day chunk intervals.
                     Prefect flow: one parent flow with three extraction
                     tasks running in parallel, then a dbt transform step.
                     Two options for the historical backfill: single batch
                     (simpler, risk of rate limiting) or chunked by week
                     (slower, more resilient). I recommend chunked.
```

The Guide relays this to you along with the full plan document. You read it in the artifact viewer, ask a question about the chunk interval, and approve.

This is the **plan-approve-execute** cycle: no work begins until you sign off. If the Conductor discovers mid-project that the Garmin API returns data in a different format than expected, it surfaces the problem back to you for re-approval before changing direction.

<!-- TODO: screenshot of a plan document displayed in the artifact viewer -->

### 3. Execution: agents coordinate in parallel

Once approved, the Conductor builds the task hierarchy in the database and starts working. On the kanban board, you see tasks appear across status columns: "Create TimescaleDB hypertables", "Write Prefect extraction flow", "Configure dbt transforms", "Run 3-month backfill", "Build analytical dashboard".

<!-- TODO: screenshot of the kanban board showing tasks across status columns with project swimlanes -->

Agents communicate through direct messages for real-time coordination and task comments for the permanent record. The Conductor assigns tasks, tracks progress, and posts updates:

```text
Conductor → Reviewer:  Backfill complete. 89 days of data loaded.
                        garmin_sleep: 89 rows, garmin_heart_rate: 127,440
                        rows (1-min intervals), garmin_activities: 156 rows.
                        Row counts verified against API response counts.
                        Ready for your review of the analysis. Task #47.
```

### 4. The Reviewer checks everything

The Reviewer reads the analysis, checks the SQL logic, and applies statistical scrutiny:

```text
Reviewer → Conductor:  Two issues on task #47.
                        (1) The sleep vs. exercise correlation (r=0.31) is
                        presented as "moderate" but the 95% CI spans
                        [0.08, 0.51] — too wide to draw conclusions with
                        n=89. Add the CI to the dashboard and soften the
                        language. (2) The weekly heart rate trend uses a
                        7-day moving average but the first week is partial
                        (5 days). Either drop it or note the caveat.
```

Nothing ships without Reviewer sign-off. The Conductor fixes both issues and resubmits.

### 5. Results

When the work finishes, you get three things:

**An interactive dashboard** in the artifact viewer: sleep trends, heart rate zones, activity breakdowns, with filters and drill-downs. The dashboard runs as a sandboxed HTML application with full JavaScript execution and can query the System2 database for live project metadata.

<!-- TODO: screenshot of the health dashboard artifact in the viewer: charts, filters, a data table -->

**A narrative project story** written by the Narrator: what the goal was, what the Conductor tried, where the Reviewer pushed back, what the final findings were, and how decisions were made. A journalistic reconstruction of the entire project arc.

**A full audit trail** in the database: every task with status history, every comment with agent attribution and timestamps, every decision documented. Visible on the kanban board and queryable via SQL.

### 6. The system remembers

After the project, the Narrator's scheduled jobs kick in. The daily summary captures what happened. Long-term memory records that your Garmin data uses the `garminconnect` library, that your preferred chunk interval is 7 days, that DiegoTower runs TimescaleDB. Next time you ask for anything involving Garmin or time-series data, the system already knows your stack.

The Conductor's role-specific knowledge file now contains a note: "Garmin Connect API returns daily summary endpoints that lag by ~2 hours. Schedule extraction flows for early morning to ensure previous day is complete." Every future Conductor inherits this lesson.

---

## What lives where

```text
~/.system2/
├── config.toml                      Settings and API keys (0600, gitignored)
├── app.db                           SQLite database (gitignored)
├── knowledge/                       Persistent knowledge (git-tracked)
│   ├── infrastructure.md            Your data stack, servers, tools
│   ├── user.md                      Your background and preferences
│   ├── memory.md                    Long-term learnings (Narrator-maintained)
│   ├── guide.md                     Guide role-specific knowledge
│   ├── conductor.md                 Conductor role-specific knowledge
│   ├── narrator.md                  Narrator role-specific knowledge
│   ├── reviewer.md                  Reviewer role-specific knowledge
│   └── daily_summaries/             Daily activity logs
├── projects/
│   └── {id}_{name}/
│       ├── plan_{uuid}.md           Conductor's proposal (pre-approval)
│       ├── log.md                   Continuous project log (Narrator)
│       ├── project_story.md         Final narrative (Narrator)
│       ├── artifacts/               Published reports and dashboards
│       └── scratchpad/              Working files
├── skills/                          User-created workflow instructions
├── sessions/                        Agent conversations as JSONL (gitignored)
└── logs/                            Server logs (gitignored)
```

---

## Configuration

All settings live in `~/.system2/config.toml`, created during onboarding.

- **`[llm]`**: primary provider, fallback order, per-provider API keys with automatic rotation
- **`[services.brave_search]`**: optional web search via Brave Search API
- **`[scheduler]`**: Narrator frequency (default: every 30 minutes)

**Supported LLM providers:** Anthropic, Google Gemini, OpenAI, Cerebras, Groq, Mistral, OpenRouter, xAI, and any OpenAI-compatible endpoint.

See [docs/configuration.md](docs/configuration.md) for the full reference.

---

## Tech stack

| Layer | Technology |
| ----- | ---------- |
| Runtime | Node.js, TypeScript |
| Agent SDK | [pi-coding-agent](https://github.com/badlogic/pi-mono) |
| HTTP / WebSocket | Express, ws |
| Database | SQLite (WAL mode) |
| UI | React 18, Zustand, Vite |
| Scheduling | Croner |
| Package manager | pnpm |

---

## Documentation

| Doc | Contents |
| --- | -------- |
| [Architecture](docs/architecture.md) | Monorepo structure, runtime, request lifecycle, trust model |
| [Agents](docs/agents.md) | Agent roles, lifecycle, messaging, failover, session management |
| [Tools](docs/tools.md) | Agent tools: filesystem, database, web, messaging, artifacts |
| [Database](docs/database.md) | `app.db` schema: projects, tasks, agents, comments, artifacts |
| [Knowledge System](docs/knowledge-system.md) | Knowledge files, prompt injection, git tracking |
| [Skills](docs/skills.md) | Reusable workflow instructions, SKILL.md format, role filtering |
| [Artifacts](docs/artifacts.md) | Published outputs, storage, UI rendering, postMessage bridge |
| [Scratchpad](docs/scratchpad.md) | Working area for exploration, prototyping, data snapshots |
| [Scheduler](docs/scheduler.md) | Narrator jobs, catch-up on missed runs |
| [WebSocket Protocol](docs/websocket-protocol.md) | Real-time UI-server communication |
| [Configuration](docs/configuration.md) | `config.toml` reference, LLM providers, failover |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, build, test, PR process |

---

## Project structure

```text
system2/
├── packages/
│   ├── cli/       # system2 CLI: onboard, start, stop, status
│   ├── server/    # HTTP + WebSocket server, agent hosting, scheduler
│   ├── shared/    # TypeScript types shared across packages
│   └── ui/        # React chat interface, kanban board, artifact viewer
└── docs/          # Developer documentation
```

---

## License

This project is proprietary software. All rights reserved.
