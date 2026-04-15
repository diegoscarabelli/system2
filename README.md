# System2

**Not a chatbot. A self-hosted AI data team that does the work.**

System2 is a multi-agent system specialized in data engineering, analysis, and analytical reasoning. It adapts to your existing data stack or builds one from scratch. You describe an analytical goal to the Guide, your single point of contact, and it spawns a team of agents that plan the approach, build pipelines, run analyses, review results for statistical fallacies, and produce traceable, interactive analysis. Every conversation builds on the last: no chat sessions, no Memento resets. Agents learn about you and your infrastructure over time. Stop the server, restart it days later: the team picks up where it left off, with project state and accumulated knowledge intact. You stay in the loop without managing the details.

Named for Kahneman's slow, deliberate mode of reasoning, System2 is the bicycle for your analytical mind. It puts AI-agent data work automation and rigorous statistical reasoning under your control, whether the data is private or public. System2 is built for epistemic autonomy: every step, from raw data sources to how the data is processed, stored, and analyzed, is in your control, traceable and verifiable end-to-end, so that your understanding of the world is grounded in evidence you can inspect, not in conclusions shaped by the incentives of whoever controls the information pipeline.

<!-- TODO: screenshot/GIF of the full UI: chat panel on the right, artifact viewer with a dashboard on the left, activity bar visible -->

---

## Quick start

**Requirements:** Node.js 20+, pnpm 8+, at least one LLM API key (Anthropic, Google, or OpenAI). Runs on macOS, Linux, and Windows.

```bash
pnpm add -g system2
system2 onboard          # API keys, LLM providers, config.toml
system2 start            # starts server on port 3000 and opens the browser
```

```bash
system2 status           # check if the server is running
system2 stop             # graceful shutdown
```

> **Note:** System2 is not yet published to npm. For now, clone and build from source: see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Key capabilities

**Multi-agent system built for data work.** A Guide is your single point of contact, your customizable interface to the world of data. It defers complex work, organized by project, to a Conductor that researches, plans, and orchestrates; a Reviewer that catches statistical fallacies and flawed methodology; and optional Workers that execute tasks in parallel. A Narrator curates short- and long-term memory on a schedule. Agents carry built-in skills for statistical analysis, SQL modeling, and data infrastructure, with system-level rules that require verification before any result is reported and Reviewer sign-off before any analytical task is marked done.

**Structured collaboration.** Agents manage work through a database-backed kanban board (visible to the user) with task hierarchies, dependencies, and comment threads, and coordinate through real-time messages. Every project follows a plan-approve-execute cycle: the Conductor researches and proposes, you approve before work begins.

**Knowledge base that learns and adapts.** Agents continuously refine git-tracked markdown files storing user preferences, data infrastructure setup, role-specific lessons, long-term memory, and reusable skills they create alongside the built-in ones. A Narrator synthesizes activity into daily summaries and project logs on a schedule, and a journalistic-style project story when work concludes.

**Interactive artifacts.** Agents craft whatever the analysis demands: dashboards that query your analytical databases live (PostgreSQL, ClickHouse, DuckDB, Snowflake, BigQuery, MySQL, MSSQL, SQLite), research articles, Jupyter notebooks, financial models. Agents surface these in the UI alongside the conversation, so you see the result the moment it is ready and can ask follow-up questions while looking at it.

**Autonomous scheduling.** Agents set reminders for their future selves to follow up on long-running work, revisit blocked tasks, or re-evaluate conditions. A cron scheduler triggers daily summaries, long-term memory updates, and project stories. Long-running commands emit heartbeat signals to report progress back to the system.

**Any LLM, automatic failover.** Anthropic, Google, OpenAI, OpenRouter, Cerebras, Mistral, Groq, xAI, and any OpenAI-compatible endpoint. Automatic key rotation, provider failover with exponential backoff, and time-based cooldowns. The system recovers on its own when providers come back.

---

## Builtin tools

Every agent has access to a core set of tools. Some tools are restricted by role or require configuration.

| Category | Tools | Description |
| -------- | ----- | ----------- |
| Filesystem | `bash`, `read`, `edit`, `write` | Shell commands with streaming output and safety guards (blocks recursive `rm`, `mkfs`, `dd`, direct `sqlite3` on app.db). File read, exact-match edit, and full-file write with auto-commit support for knowledge files. |
| Database | `read_system2_db`, `write_system2_db` | Query app.db (read-only SELECT) and manage records (create/update projects, tasks, comments, artifacts) through named operations with scope checks. |
| Communication | `message_agent` | Send messages between agents with `urgent` (interrupt) or `followUp` (queue) delivery modes. |
| Web | `web_fetch`, `web_search` | Fetch any URL and extract readable text via Mozilla Readability. Search the web via Brave Search API (requires API key in config). |
| UI | `show_artifact` | Display an artifact in the viewer panel with live reload on file changes. |
| Scheduling | `set_reminder`, `cancel_reminder`, `list_reminders` | Agents schedule delayed messages to their future selves (0.5 min to 7 days) for follow-ups, retries, and condition checks. |
| Agent lifecycle | `spawn_agent`, `terminate_agent`, `resurrect_agent` | Guide and Conductor spawn, terminate, and resurrect agents. Conductors are scoped to their own project. The Guide can resurrect archived agents with full session history. |
| Narration | `trigger_project_story` | Kick off the Narrator's project story workflow: collects all project activity, agent logs, and DB changes into a data package for the Narrator to write a journalistic reconstruction. |

See [docs/tools.md](docs/tools.md) for the full reference.

---

## Builtin skills

Skills are reusable workflow instructions that agents load on demand. Each skill is a `SKILL.md` file with step-by-step procedures, scoped to specific agent roles. System2 ships with built-in skills covering its own workflows, data infrastructure, and analytical rigor. Agents can also create new skills at runtime, stored in `~/.system2/skills/` (user-created skills override built-in ones by name).

**System2 workflows**

| Skill | Roles | What it does |
| ----- | ----- | ------------ |
| `system2-onboarding` | Guide | First-launch setup: learns about the user, detects the data stack, configures the environment, captures interaction preferences. |
| `project-creation` | Guide | Gathers requirements, creates the project in app.db, spawns Conductor and Reviewer, schedules a follow-up reminder. |
| `project-completion` | Guide | Shows the Reviewer's final report, gets user confirmation, triggers close-project and project story, terminates agents. |
| `project-restart` | Guide | Helps weigh resurrection vs. a new project, then resurrects the original agents with context intact. |
| `ui-reference` | Guide | Reference for the System2 UI layout: sidebar, artifact viewer, chat panel, kanban board. |
| `db-schema-reference` | All | Column-level schema for all app.db tables, so agents can write correct queries. |

**Data infrastructure**

| Skill | Roles | What it does |
| ----- | ----- | ------------ |
| `airflow` | Conductor, Reviewer, Worker | Apache Airflow v3: DAG design, TaskFlow API, dynamic task mapping, scheduling, production checklist. |
| `prefect` | Conductor, Reviewer, Worker | Prefect v3: flows, tasks, deployments, work pools, concurrency, error handling. |
| `timescaledb` | Conductor, Reviewer, Worker | Hypertables, chunk sizing, compression, continuous aggregates, retention policies, ingestion tuning. |
| `sql-schema-modeling` | Conductor, Reviewer, Worker | Normalization, dimensional modeling, data types, indexing patterns, partitioning, materialization. |

**Analysis and review**

| Skill | Roles | What it does |
| ----- | ----- | ------------ |
| `statistical-analysis` | Conductor, Reviewer | Frequentist and Bayesian workflows, test selection, effect sizes, power analysis, time series, reporting standards. |
| `code-review` | Conductor, Reviewer, Worker | Structured review: conventions, design, correctness, security (OWASP top 10), performance, SQL, testing, readability. |
| `reasoning-fallacy-review` | Conductor, Reviewer | Cognitive bias detection: WYSIATI, confirmation bias, anchoring, narrative fallacy, premortem, Analysis of Competing Hypotheses. |

See [docs/skills.md](docs/skills.md) for the full reference and the SKILL.md format.

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

## Automatic backups

Every time `system2 start` runs, the system creates a timestamped backup of `~/.system2/` before the server initializes. Backups are full copies stored in your home directory as `~/.system2-auto-backup-YYYY-MM-DDTHH-MM-SS/`. A cooldown period (default: 24 hours) prevents redundant copies on frequent restarts, and old backups are automatically pruned to keep only the most recent copies (default: 3).

Both settings are configurable in `config.toml`:

```toml
[backup]
cooldown_hours = 24   # minimum hours between backups
max_backups = 3       # number of backup copies to retain
```

The backup covers the entire `~/.system2/` directory: database, knowledge files, project artifacts, skills, sessions, configuration, and the shared Python environment. If something goes wrong, you can restore by copying a backup directory back to `~/.system2/`.

---

## Configuration

All settings live in `~/.system2/config.toml`, created during onboarding.

- **`[llm]`**: primary provider, fallback order, per-provider API keys with automatic rotation
- **`[services.brave_search]`**: optional web search via Brave Search API
- **`[scheduler]`**: Narrator frequency (default: every 30 minutes)
- **`[backup]`**: backup cooldown and retention (default: every 24 hours, keep 3)

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
| [Architecture](docs/architecture.md) | Project structure, runtime, request lifecycle, trust model |
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
├── src/
│   ├── cli/       # system2 CLI: onboard, start, stop, status
│   ├── server/    # HTTP + WebSocket server, agent hosting, scheduler
│   ├── shared/    # TypeScript types shared across the project
│   └── ui/        # React chat interface, kanban board, artifact viewer
└── docs/          # Developer documentation
```

---

## License

This project is proprietary software. All rights reserved.
