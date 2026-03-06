# System2 Developer Documentation

System2 is a single-user, self-hosted AI multi-agent system for working with data. Built on [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent), it automates data engineering, analysis, and reporting through coordinated AI agents with structured memory.

For installation and usage, see the [project README](../README.md).

## Architecture

- [Architecture Overview](architecture.md) -- monorepo structure, runtime components, data flow

## Packages

- [@system2/shared](packages/shared.md) -- TypeScript types shared across all packages
- [@system2/server](packages/server.md) -- Express + WebSocket server, agent hosting, scheduler
- [@system2/cli](packages/cli.md) -- CLI for server lifecycle (onboard, start, stop, status)
- [@system2/ui](packages/ui.md) -- React chat interface with artifact display

## Core Systems

- [Agents](agents.md) -- multi-agent roles, lifecycle, system prompt construction, failover
- [Tools](tools.md) -- the 8 agent tools (bash, read, write, query, messaging, artifacts, web)
- [Database](database.md) -- SQLite schema, tables, indices, query patterns
- [WebSocket Protocol](websocket-protocol.md) -- client/server message types and flow
- [Knowledge System](knowledge-system.md) -- persistent memory, daily summaries, git tracking
- [Scheduler](scheduler.md) -- Croner jobs, daily summary pipeline, catch-up logic

## Reference

- [Configuration](configuration.md) -- config.toml reference, LLM failover, data directory
- [Development](development.md) -- dev setup, build system, code quality, contributing
