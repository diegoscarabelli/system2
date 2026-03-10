# System2

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D8-orange.svg)](package.json)

**System2 is your self-hosted AI data team.** You chat with a Guide agent that delegates complex work to a crew of specialized agents working in parallel — extracting data, running analyses, reviewing results for statistical rigor, and narrating what happened. You stay in the loop without managing the details.

---

## What it does

You describe a goal in plain language. System2 handles the rest:

- **Extracts** data from APIs, databases, or files
- **Transforms and loads** it into your data stack
- **Analyzes** it — with statistical rigour checks built in
- **Generates** reports and dashboards as HTML artifacts
- **Narrates** what happened, what was found, and why decisions were made

Every project produces a traceable record: tasks, comments, agent decisions, and a journalistic project story written by the Narrator when the work completes.

---

## How it works

System2 runs a multi-agent system on your machine:

| Agent         | Role                                                                        |
|---------------|-----------------------------------------------------------------------------|
| **Guide**     | User-facing. Answers questions, spawns Conductor + Reviewer per project.    |
| **Conductor** | Plans tasks in app.db, runs pipelines, spawns specialist agents.            |
| **Reviewer**  | Validates SQL logic, statistical rigour, and analytical correctness.        |
| **Narrator**  | Daily summaries, long-term memory, project story at project completion.     |

Agents communicate via direct messages and share a structured SQLite database (`app.db`) for projects, tasks, and findings. All agent conversations are persisted as JSONL files for full traceability.

---

## Example interaction

```text
You:    Analyze our LinkedIn campaigns for the last 6 months.
        What's driving engagement and where is budget being wasted?

Guide:  Got it. A few questions first: where does the LinkedIn data live —
        CSV export, API, or already in a database? And should this be a
        one-time analysis or a recurring pipeline?

You:    CSV export for now. One-time analysis, I just need the report.

Guide:  Project created. Conductor and Reviewer are spinning up now.
        I'll keep you posted.

        [15 min later]
        Extraction done — 12,450 rows, 6 months. Cleaning underway.

        [35 min later]
        Analysis complete. Reviewer approved the methodology.
        Report is ready in the panel — Video campaigns are 3.2× cheaper
        per engagement than image ads in Q4. Budget waste concentrated
        in the "Brand Awareness" objective, which has a 0.8% CTR vs
        4.1% for "Lead Gen".

        The Narrator has written a full project story to
        ~/.system2/projects/story-1.md.
```

---

## Requirements

- Node.js 18+
- pnpm 8+
- At least one LLM API key (Anthropic, Google, or OpenAI)
- macOS, Linux, or Windows

---

## Quick Start

> System2 is not yet published to npm. To try it, clone and build from source — see [docs/development.md](docs/development.md).

```bash
# After building from source:
system2 onboard   # interactive setup: API keys, config.toml
system2 start     # start server and open browser
```

---

## Configuration

All settings live in `~/.system2/config.toml`, created during `system2 onboard`. See [docs/configuration.md](docs/configuration.md) for the full reference.

Key settings:

- **`[llm]`** — primary provider, fallback order, API keys (supports multiple keys per provider with automatic rotation)
- **`[services.brave_search]`** — optional web search via Brave Search API
- **`[scheduler]`** — how often the Narrator runs (default: every 30 minutes)

---

## Key Features

**Automatic LLM failover** — when an API key hits a rate limit or auth error, System2 switches to the next key or provider without interrupting the conversation. See [docs/configuration.md](docs/configuration.md).

**Structured memory** — knowledge about your infrastructure, preferences, and past projects is maintained in `~/.system2/knowledge/` and injected into every agent's context. See [docs/knowledge-system.md](docs/knowledge-system.md).

**Statistical rigour** — the Reviewer checks every analysis for p-hacking, multiple comparisons without correction, effect sizes, confidence intervals, and causation claims from observational data.

**Narrative lineage** — when a project completes, the Narrator reconstructs it journalistically: what the goal was, what was found, what wasn't, how decisions were made. Stories are stored in `~/.system2/projects/` and committed to git.

**Live artifact display** — agents produce HTML dashboards and reports that appear directly in the UI. Interactive dashboards can query `app.db` via a secure postMessage bridge.

---

## Project Structure

```text
system2/
├── packages/
│   ├── cli/       # system2 CLI (start, stop, status, onboard)
│   ├── server/    # HTTP + WebSocket server, agent hosts, tools, scheduler
│   ├── shared/    # TypeScript types shared across packages
│   └── ui/        # React chat interface
└── docs/          # Developer documentation
```

---

## Documentation

| Doc                                               | Contents                                                        |
|---------------------------------------------------|-----------------------------------------------------------------|
| [docs/agents.md](docs/agents.md)                  | Agent roles, lifecycle, spawn/terminate, work management        |
| [docs/tools.md](docs/tools.md)                    | All agent tools including spawn_agent and terminate_agent       |
| [docs/database.md](docs/database.md)              | app.db schema: projects, tasks, agents, task_links, comments    |
| [docs/knowledge-system.md](docs/knowledge-system.md) | Knowledge files and dynamic prompt injection                 |
| [docs/configuration.md](docs/configuration.md)    | config.toml reference, LLM providers, failover                  |
| [docs/architecture.md](docs/architecture.md)      | Monorepo structure, server architecture, SDK integration        |
| [docs/development.md](docs/development.md)        | Building from source, dev workflow                              |
| [CONTRIBUTING.md](CONTRIBUTING.md)                | Contributing guidelines, code standards, PR process             |

---

## License

This project is proprietary software. All rights reserved.
