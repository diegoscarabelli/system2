# CLAUDE.md

This file provides guidance to AI coding agents working with code in this repository. The following sections provide references to other files that must be read before any work to acquire critical knowledge about system2.

IMPORTANT: system2 is not released yet, no one installed it. No need to worry about migrations for breaking changes, yet.

## README.md

The [`README.md`](README.md) file is the project's public-facing landing page: what System2 is, key features, quick start, and links to docs.

## CONTRIBUTING.md

The [`CONTRIBUTING.md`](CONTRIBUTING.md) file contains development guidelines. Key sections:

- **How to Contribute**: Fork-based workflow, branch naming conventions, PR process.
- **Development Setup**: Prerequisites (Node.js >= 20, pnpm >= 8) and setup commands.
- **Building**: Package build order and outputs.
- **Code Quality**: Biome formatting/linting rules and commands.
- **Before Committing**: Required quality checks before every commit.
- **Code Review Process**: How PRs are reviewed and merged.

## Developer Documentation

The [`docs/`](docs/) directory contains in-depth documentation. Start with [`docs/README.md`](docs/README.md) for an overview, then refer to individual files as needed:

| File | Description |
| ---- | ----------- |
| [`architecture.md`](docs/architecture.md) | Monorepo structure, runtime components, pi-coding-agent integration |
| [`agents.md`](docs/agents.md) | Multi-agent orchestration, LLM failover, inter-agent messaging |
| [`tools.md`](docs/tools.md) | Custom agent tools: typed parameters, factory pattern, execution |
| [`database.md`](docs/database.md) | SQLite schema, WAL mode, better-sqlite3 usage |
| [`websocket-protocol.md`](docs/websocket-protocol.md) | Real-time UI–server communication protocol |
| [`knowledge-system.md`](docs/knowledge-system.md) | Persistent knowledge files, git-tracked, dynamic prompt injection |
| [`scheduler.md`](docs/scheduler.md) | Cron-based Narrator jobs via Croner |
| [`configuration.md`](docs/configuration.md) | `config.toml` settings and API keys |
| [`packages/cli.md`](docs/packages/cli.md) | CLI: onboarding, daemon management, status |
| [`packages/server.md`](docs/packages/server.md) | Server: HTTP, WebSocket, agents, scheduler |
| [`packages/shared.md`](docs/packages/shared.md) | Shared TypeScript type definitions |
| [`packages/ui.md`](docs/packages/ui.md) | React UI: real-time chat, artifacts |

## Command Reference

```bash
pnpm install              # Install dependencies
pnpm build                # Build all packages
pnpm dev                  # Run all packages in dev mode
pnpm check                # Run format check and lint
pnpm format               # Auto-fix formatting
pnpm typecheck            # Run TypeScript type checking
pnpm test                 # Run all tests (vitest)
pnpm test:watch           # Run tests in watch mode
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
pnpm test                 # Run all tests
```

If `pnpm check` reports issues:

```bash
pnpm format               # Auto-fix formatting issues
```

Do not commit code that fails these checks.
