# System2 Developer Documentation

System2 is a single-user, self-hosted AI multi-agent system for working with data. Built on [pi-coding-agent](https://github.com/badlogic/pi-mono), it automates data engineering, analysis, and reporting through coordinated AI agents with structured memory.

For installation and usage, see the [project README](../README.md).

## Architecture

- [Architecture Overview](architecture.md): How the monorepo is organized, how the runtime components connect, and how data flows through the system.

## Packages

- [@system2/shared](packages/shared.md): The TypeScript types and interfaces that all other packages depend on.
- [@system2/server](packages/server.md): The main runtime — hosts agents, serves the UI over HTTP and WebSocket, and runs scheduled jobs.
- [@system2/cli](packages/cli.md): Command-line tool for managing the server (initial setup, starting, stopping, checking status).
- [@system2/ui](packages/ui.md): The browser-based chat interface where you interact with the Guide agent and view artifacts.

## Core Systems

- [Agents](agents.md): How the four agent roles (Guide, Conductor, Narrator, Reviewer) work together — their lifecycles, how system prompts are assembled, and how LLM failover is handled.
- [Tools](tools.md): The tools available to agents — what each one does, how they are registered, and how permissions are enforced.
- [Database](database.md): The SQLite schema that stores projects, tasks, agents, and comments — table definitions, indices, and common query patterns.
- [WebSocket Protocol](websocket-protocol.md): The message format between the UI and server — how chat messages, tool calls, and agent events are exchanged in real time.
- [Knowledge System](knowledge-system.md): How agents persist and share memory — knowledge files, daily summaries, project logs, project stories, and git tracking of `~/.system2/`.
- [Scheduler](scheduler.md): The background job system — what runs on schedule (daily summaries, memory updates), how missed jobs are caught up, and how to add new ones.

## Reference

- [Configuration](configuration.md): All settings in `config.toml` — LLM provider credentials, failover chains, application directory paths, and feature flags.
- [Development](development.md): How to set up a dev environment, build the project, run tests, and contribute code.
