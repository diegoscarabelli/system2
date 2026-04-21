# System2

System2 is a multi-agent system for data engineering, analysis, and statistical reasoning. It adapts to your existing data stack or builds one from scratch. Describe what you want to learn to the Guide, your single point of contact, and it spawns a team of agents that plan the approach, build pipelines, run analyses, review results for statistical fallacies, and produce traceable, interactive output.

Named for [Kahneman's](https://en.wikipedia.org/wiki/Thinking,_Fast_and_Slow) slow, deliberate mode of reasoning, System2 is the bicycle for your analytical mind. It exists to help people think more clearly about complex questions and empower everyone, regardless of skill, to acquire, interpret, and share rigorous analysis grounded in evidence and methods they can inspect.

<!-- TODO: screenshot/GIF of the full UI: chat panel on the right, artifact viewer with a dashboard on the left, activity bar visible -->

---

## Quick start

### Prerequisites

1. **Node.js 20+** and **pnpm 8+**
2. **An LLM API key** (required). [OpenRouter](https://openrouter.ai/) is highly recommended: it provides access to multiple models with a single key. Anthropic, Google, OpenAI, and other providers also work.
3. **Brave Search API key** (highly recommended). Enables agents to search the web and fetch web pages content. This is useful for researching APIs, documentation, and data sources on the web. [Get one here](https://brave.com/search/api/).

### Install and run

```bash
pnpm add -g system2
system2 onboard          # one-time setup (see below)
system2 start            # starts the server and opens the browser
```

`system2 onboard` creates the `~/.system2/` directory and walks you through configuration: pick your LLM provider, enter API keys (you can add multiple for rotation and fallback providers for redundancy), and optionally set up Brave Search. Everything is saved to `~/.system2/config.toml`, which you can edit directly later.

`system2 start` launches the server and opens your browser at `http://localhost:4242`. On first launch, the Guide detects that the knowledge files are still templates and runs the onboarding skill through the web UI: it introduces itself, learns about you and your goals, detects your system, and then walks you through setting up a local data stack. Unless you direct it otherwise, the recommended one includes an analytical database (PostgreSQL with TimescaleDB by default), a shared Python environment with notebooks and data libraries, an ETL framework from [openetl_scaffold](https://github.com/diegoscarabelli/openetl_scaffold), and an orchestrator (Prefect or Airflow). The Guide adapts to what you already have: if you have an existing database, orchestrator, or pipeline repo, it integrates with those instead. By the end, you have a working analytical database, a data engineering orchestrator, and a code repository ready to build end-to-end data pipelines, with knowledge files populated with your setup and the Guide ready for your first project.

```bash
system2 status           # check if the server is running
system2 stop             # graceful shutdown
```

---

## Key capabilities

**Multi-agent system built for data work.** The Guide is your single point of contact, built to feel like talking to a friendly, trusted colleague: its continuous session gives it long-term memory of your interactions and System2's work. It defers complex work, organized by project, to a Conductor that researches, plans, and orchestrates; a Reviewer that catches statistical fallacies and flawed methodology; and optional Workers that execute tasks in parallel. A Narrator curates short- and long-term memory on a schedule. Agents carry built-in skills for statistical analysis, SQL modeling, and data infrastructure, with system-level rules that require verification before any result is reported and Reviewer sign-off before any analytical task is marked done.

**Structured collaboration.** Agents manage work through a database-backed kanban board (visible to the user) with task hierarchies, dependencies, and comment threads, and coordinate through real-time messages. Every project follows a plan-approve-execute cycle: the Conductor researches and proposes, you review and approve before work begins.

**Knowledge base that learns and adapts.** Every conversation builds on the last. Agents continuously refine git-tracked markdown files storing user preferences, data infrastructure setup, role-specific lessons, long-term memory, and reusable skills they create alongside the built-in ones. A Narrator synthesizes activity into daily summaries, project logs, and a journalistic-style project story when work concludes. Stop the server, restart it days later: the team picks up where it left off, with project state and accumulated knowledge intact.

**Interactive artifacts.** Agents craft whatever the analysis demands: dashboards that query your analytical databases live (PostgreSQL, ClickHouse, DuckDB, Snowflake, BigQuery, MySQL, MSSQL, SQLite), research articles, Jupyter notebooks, financial models. Agents surface these in the UI alongside the conversation, so you see the result the moment it is ready and can ask follow-up questions while looking at it.

**Autonomous scheduling.** Agents set reminders for their future selves to follow up on long-running work, revisit blocked tasks, or re-evaluate conditions. A cron scheduler triggers daily summaries, long-term memory updates, and project stories. Long-running commands emit heartbeat signals to report progress back to the system.

**Any LLM, automatic failover.**  OpenRouter, Anthropic, Google, OpenAI, Cerebras, Mistral, Groq, xAI, and any OpenAI-compatible endpoint. Automatic key rotation, provider failover with exponential backoff, and time-based cooldowns. The system recovers on its own when providers come back.

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

## What lives where

System2's home directory is `~/.system2/`. It holds all system state: configuration, the internal database (projects, tasks, agents), knowledge files, project workspaces, chat histories, and logs. The directory is a git repository, so knowledge file changes are version-tracked and reversible.

```text
~/.system2/
├── .gitignore
├── app.db                           SQLite database (gitignored)
├── config.toml                      Settings and API keys (0600, gitignored)
├── knowledge/                       Persistent knowledge (git-tracked)
│   ├── conductor.md                 Conductor role-specific knowledge
│   ├── daily_summaries/             Daily activity logs
│   ├── guide.md                     Guide role-specific knowledge
│   ├── infrastructure.md            Your data stack, servers, tools
│   ├── memory.md                    Long-term learnings (Narrator-maintained)
│   ├── narrator.md                  Narrator role-specific knowledge
│   ├── reviewer.md                  Reviewer role-specific knowledge
│   ├── user.md                      Your background and preferences
│   └── worker.md                    Worker role-specific knowledge
├── logs/                            Server logs (gitignored)
├── projects/
│   └── {dir_name}/                  {id}_{slug} from project record (e.g. 1_linkedin-campaign)
│       ├── artifacts/               Published reports and dashboards
│       │   ├── plan_{uuid}.md       Conductor's proposal (pre-approval)
│       │   └── project_story.md     Final narrative (Narrator)
│       ├── log.md                   Continuous project log (Narrator)
│       └── scratchpad/              Working files
├── server.pid                       PID file when server is running (gitignored)
├── sessions/                        Agent conversations as JSONL (gitignored)
├── skills/                          User-created workflow instructions
└── venv/                            Shared Python environment (notebooks, data libraries)
```

Agents run in a shell and can work with any directory on your machine. For data engineering work, they typically create and manage code in external repositories (e.g. `~/repos/system2_data_pipelines`), keeping pipeline code separate from the System2 home directory.

See [docs/knowledge-system.md](docs/knowledge-system.md) for how knowledge files are injected into agent prompts, file ownership, and the git tracking model. See [docs/architecture.md](docs/architecture.md) for the full runtime directory layout.

---

## Builtin tools

Every agent has access to a core set of tools. Some tools are restricted by role or require configuration.

| Category | Tools | Description |
| -------- | ----- | ----------- |
| Filesystem | `bash`, `read`, `edit`, `write` | Shell commands with streaming output and safety guards (blocks recursive `rm`, `mkfs`, `dd`, direct `sqlite3` on app.db). File read, exact-match edit, and file write/create operations; `write` does not overwrite existing non-empty files. Auto-commit via `commit_message` applies to files under `~/.system2/`. |
| App database | `read_system2_db`, `write_system2_db` | Query app.db (read-only SELECT) and manage records (create/update projects, tasks, comments, artifacts) through named operations with scope checks. |
| Communication | `message_agent` | Send messages between agents with `urgent` (interrupt) or `followUp` (queue) delivery modes. |
| Web | `web_fetch`, `web_search` | Fetch any URL and extract readable text via Mozilla Readability. Search the web via Brave Search API (requires API key in config). |
| UI | `show_artifact` | Display an artifact (or any other supported file) in the viewer panel with live reload on file changes. |
| Scheduling | `set_reminder`, `cancel_reminder`, `list_reminders` | Agents schedule delayed messages to their future selves (0.5 min to 7 days) for follow-ups, retries, and condition checks. |
| Agent lifecycle | `spawn_agent`, `terminate_agent`, `resurrect_agent` | Guide and Conductors can spawn and terminate agents; Conductors are limited to their own project. `resurrect_agent` restores an archived agent's persisted session history. The Guide can resurrect any archived non-singleton agent, while Conductors can resurrect only agents in their own project. |
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
| `db-schema-reference` | Guide, Conductor, Reviewer, Worker | Column-level schema for all app.db tables, so agents can write correct queries. |

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

## Automatic backups

On a normal `system2 start`, when the CLI launches the background server process, the system creates a timestamped backup of `~/.system2/` before the server initializes. Backups are full copies stored in your home directory as `~/.system2-auto-backup-YYYY-MM-DDTHH-MM-SS/`. A cooldown period (default: 24 hours) prevents redundant copies on frequent restarts, and old backups are automatically pruned to keep only the most recent copies (default: 3).

Both settings are configurable in `config.toml`:

```toml
[backup]
cooldown_hours = 24   # minimum hours between backups
max_backups = 3       # number of backup copies to retain
```

The backup covers the entire `~/.system2/` directory: database, knowledge files, project artifacts, skills, sessions, configuration, and the shared Python environment. If something goes wrong, you can restore by copying a backup directory back to `~/.system2/`.

---

## Configuration

All settings live in `~/.system2/config.toml`, created by `system2 onboard`.

- **`[llm]`**: primary provider, fallback order, per-provider API keys with automatic rotation
- **`[databases.*]`**: analytical database connections (PostgreSQL, ClickHouse, DuckDB, Snowflake, BigQuery, MySQL, MSSQL, SQLite) that agents and dashboard artifacts can query
- **`[agents.*]`**: per-role overrides for thinking level, context compaction depth, and model selection per provider
- **`[services.brave_search]`**: web search via Brave Search API (highly recommended)
- **`[scheduler]`**: Narrator frequency (default: every 30 minutes)
- **`[backup]`**: backup cooldown and retention (default: every 24 hours, keep 3)

**Supported LLM providers:** Anthropic, Google Gemini, OpenAI, OpenRouter, Cerebras, Groq, Mistral, xAI, and any OpenAI-compatible endpoint.

See [docs/configuration.md](docs/configuration.md) for the full reference.

---

## Documentation

For a deeper look at how System2 works, see the [developer documentation](docs/README.md). It covers the agent system, tools, database schema, knowledge persistence, skills, scheduling, and the real-time WebSocket protocol. For contributing, see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
