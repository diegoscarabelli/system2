# System2 Developer Documentation

System2 is a single-user, self-hosted AI multi-agent system for working with data. Built on [pi-coding-agent](https://github.com/badlogic/pi-mono), it automates data engineering, analysis, and reporting through coordinated AI agents with structured memory.

For installation and usage, see the [project README](../README.md).

## Architecture

- [Architecture Overview](architecture.md): How the project is organized, how the runtime components connect, and how data flows through the system.

## Source Layout

- [Shared types](shared.md): The TypeScript types and interfaces used across the codebase.
- [Server](server.md): The main runtime, hosting agents, serving the UI over HTTP and WebSocket, and running scheduled jobs.
- [CLI](cli.md): Command-line tool for managing the server (initial setup, OAuth login/logout, starting, stopping, checking status).
- [UI](ui.md): The browser-based chat interface where you interact with the Guide agent and view artifacts.

## Core Systems

- [Agents](agents.md): How the five agent roles (Guide, Conductor, Narrator, Reviewer, Worker) work together, including their lifecycles, how system prompts are assembled, how LLM failover is handled, and how session rotation prevents context bloat in long-running agents.
- [Tools](tools.md): The tools available to agents, including what each one does, how they are registered, and how permissions are enforced.
- [Database](database.md): The SQLite schema that stores projects, tasks, agents, and comments, with table definitions, indices, and common query patterns.
- [Artifacts](artifacts.md): What artifacts are (published analytical outputs), where they live on disk, database registration, UI rendering (iframes, markdown, live reload), and the postMessage bridge for interactive dashboards.
- [Scratchpad](scratchpad.md): The working area for exploration, prototyping, and debugging, including project-scoped and project-free locations, recommendations for intermediate data formats and notebook workflows, and the promotion path to artifacts.
- [WebSocket Protocol](websocket-protocol.md): The message format between the UI and server, covering how chat messages, tool calls, and agent events are exchanged in real time.
- [Knowledge System](knowledge-system.md): How agents persist and share memory, including knowledge files, daily summaries, project logs, project stories, and git tracking of `~/.system2/`.
- [Skills](skills.md): Reusable workflow instructions for agents, including the SKILL.md format, discovery from built-in and user directories, role filtering, and XML index injection.
- [Scheduler](scheduler.md): The background job system, covering what runs on schedule (daily summaries, memory updates), how missed jobs are caught up, and how to add new ones.

## Reference

- [Configuration](configuration.md): All settings in `config.toml`, including LLM provider credentials, OAuth tier and re-auth, failover chains, database connections, per-role agent overrides, and operational settings.
- [Contributing](../CONTRIBUTING.md): Development setup, code standards, testing, and PR process.
