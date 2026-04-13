# System2

**Not a chatbot. A self-hosted AI data team that does the work.**

System2 is a multi-agent system that extracts, transforms, analyzes, and reviews your data with the rigor you would expect from a human analyst. You talk to a Guide agent in a browser-based chat interface. Behind the scenes, specialized agents plan the work, execute it in parallel, check each other's reasoning, and write up what they found. You stay in the loop without managing the details.

There are no chat sessions. The Guide maintains a single continuous conversation that accumulates knowledge over time: your infrastructure, your preferences, lessons from past projects. Every interaction builds on the last. System2 is not a tool you restart; it is a team member that remembers.

> **TL;DR:** You describe a data goal in plain language. System2 spawns a team of AI agents that research the domain, plan the approach (with your approval), build pipelines, run analyses, review results for statistical fallacies, and produce traceable reports. Everything is persisted: tasks, decisions, findings, and a narrative project story. Runs entirely on your machine.

<!-- TODO: screenshot/GIF of the full UI: chat panel on the right, artifact viewer with a dashboard on the left, activity bar visible -->

---

## See it in action

```text
You:       Analyze our LinkedIn campaigns for the last 6 months.
           What's driving engagement and where is budget being wasted?

Guide:     A few questions first: where does the LinkedIn data live,
           CSV export, API, or already in a database? And should this
           be a one-time analysis or a recurring pipeline?

You:       CSV export for now. One-time analysis, I just need the report.

Guide:     Project created. Conductor and Reviewer are spinning up.
```

From here, the Conductor researches the data, writes a plan, and waits for your approval before executing. The Reviewer checks every statistical claim. When the work finishes, you get:

- An interactive HTML dashboard in the artifact viewer
- A narrative project story reconstructing what was found and how decisions were made
- A full audit trail of tasks, comments, and agent reasoning in the database

<!-- TODO: screenshot of the kanban board showing tasks across status columns with project swimlanes -->
<!-- TODO: screenshot of an interactive dashboard artifact displayed in the artifact viewer -->

---

## How it works

Four agents, each with a distinct role:

| Agent | What it does |
| ----- | ------------ |
| **Guide** | Your interface. Answers questions, creates projects, delegates to Conductors, translates between you and the technical work. |
| **Conductor** | Researches the domain, writes a plan for your approval, builds the task hierarchy, executes or delegates, coordinates the Reviewer. One per project. |
| **Reviewer** | Checks SQL logic, statistical methodology, and analytical reasoning. Catches p-hacking, multiple comparisons without correction, causal claims from observational data, and missing confidence intervals. Nothing ships without Reviewer sign-off. |
| **Narrator** | Runs on a schedule. Writes daily summaries, maintains long-term memory, and produces a journalistic project story when work completes. |

Agents communicate through direct messages and share a structured SQLite database for projects, tasks, and findings. All conversations are persisted as JSONL files. The Guide spawns and terminates agents as needed, and Conductors can spawn additional specialist agents within their projects.

<!-- TODO: render the ASCII system diagram from docs/architecture.md as an SVG image -->

---

## The interface

The UI is a browser-based workspace with a VSCode-style activity bar:

- **Chat panel** (right): multi-agent chat with streaming. Switch between agents to inspect their work. Send steering messages to interrupt an agent mid-turn.
- **Artifact viewer** (left): tabbed display for interactive HTML dashboards, markdown reports, images, and PDFs. Live reload on file changes. A postMessage bridge gives dashboards read-only SQL access to `app.db`.
- **Kanban board**: live task dashboard with project swimlanes, status columns, priority indicators, and click-through to task details and comments.
- **Agent pane**: shows all active agents with busy/idle indicators and context window usage.
- **Artifact catalog**: browsable list of all registered artifacts, filterable by project and tags.
- **Cron jobs panel**: execution history for the Narrator's scheduled jobs.

<!-- TODO: 2x2 grid of screenshots: (1) chat with streaming, (2) kanban board, (3) artifact dashboard, (4) agent pane -->

---

## Key capabilities

**Structured work management.** Projects, tasks with hierarchy and dependencies, priority levels, comments, and status tracking. All in SQLite with a live kanban board.

**Statistical rigor built in.** The Reviewer applies a System 2 thinking lens (Kahneman) to every analytical output: are the sample sizes sufficient? Are effect sizes reported alongside p-values? Is this correlation being presented as causation?

**Persistent, evolving knowledge.** Markdown files about your infrastructure, preferences, and lessons learned, git-tracked and re-read on every LLM call. Edits take effect immediately. Agents improve over time without code changes.

**Narrative traceability.** When a project completes, the Narrator reconstructs it as a story: what the goal was, what approaches were considered, what was found, what wasn't, and why decisions were made.

**Interactive artifacts.** HTML dashboards with JavaScript execution, displayed in sandboxed iframes with live reload. Dashboards can query System2's internal database or any configured external database (PostgreSQL, MySQL, ClickHouse, DuckDB, Snowflake, BigQuery, MSSQL, SQLite) for live data via a built-in postMessage bridge.

**Multi-provider LLM failover.** Configure multiple providers and API keys. Rate limits, auth errors, and transient failures trigger automatic key rotation and provider fallover with exponential backoff. Supports Anthropic, Google Gemini, OpenAI, Cerebras, Mistral, OpenRouter, Groq, xAI, and any OpenAI-compatible endpoint (LiteLLM, vLLM, Ollama).

**Skills framework.** Reusable workflow instructions that agents load on demand, filtered by role. Agents proactively create skills when they recognize reusable patterns.

**Plan-approve-execute.** Every project follows a mandatory cycle: the Conductor researches, discusses options with the Guide, and presents a plan. You approve before any execution begins. Mid-project changes surface back to you for re-approval.

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

## What makes System2 different

| | System2 | Typical AI assistant |
| - | ------- | ------------------- |
| **Work model** | Multi-agent: plan, execute, review in parallel | Single LLM loop |
| **Continuity** | Single persistent session, no "new chat"; accumulates knowledge | Resets between conversations |
| **Analytical rigor** | Dedicated Reviewer agent checking statistical methodology | No validation layer |
| **Traceability** | Tasks, comments, agent IDs, timestamps, narrative stories | Chat logs (if saved) |
| **Outputs** | Interactive HTML dashboards with live database queries | Text and code |
| **Approval gates** | Plan-approve-execute with explicit user gates | No structured lifecycle |
| **LLM resilience** | Multi-provider failover with key rotation and cooldowns | Single provider |

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
