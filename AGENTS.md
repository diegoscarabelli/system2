# AGENTS.md

This file provides guidance to AI coding agents working with code in this repository.

## Developer Documentation

The [`docs/`](docs/README.md) directory contains in-depth developer documentation:

- **Architecture**: Monorepo structure, runtime components, pi-coding-agent integration.
- **Packages**: Detailed docs for each package (cli, server, shared, ui).
- **Core Systems**: Agents, tools (`read_system2_db`, `write_system2_db`, `spawn_agent`, `terminate_agent`, and others), database schema, WebSocket protocol, knowledge system, scheduler.
- **Reference**: Configuration (config.toml), development workflow, contributing guide.

See [`docs/agents.md`](docs/agents.md) for the System2 agent architecture, work management conventions, and the inter-agent communication protocol.

## README.md

The [`README.md`](README.md) file is the project's public-facing landing page: what System2 is, key features, quick start, and links to docs.

## CONTRIBUTING.md

The [`CONTRIBUTING.md`](CONTRIBUTING.md) file contains development guidelines. Key sections:

- **How to Contribute**: Fork-based workflow, branch naming conventions, PR process.
- **Development Setup**: Prerequisites (Node.js >= 18, pnpm >= 8) and setup commands.
- **Building**: Package build order and outputs.
- **Code Quality**: Biome formatting/linting rules and commands.
- **Before Committing**: Required quality checks before every commit.
- **Code Review Process**: How PRs are reviewed and merged.

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
