# Contributing to System2

Thank you for your interest in contributing to System2! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [How to Contribute](#how-to-contribute)
  - [External Contributors Workflow](#external-contributors-workflow)
  - [Reporting Bugs](#reporting-bugs)
  - [Suggesting Features](#suggesting-features)
  - [Submitting Pull Requests](#submitting-pull-requests)
- [Development Setup](#development-setup)
  - [Prerequisites](#prerequisites)
  - [Initial Setup](#initial-setup)
  - [Development Workflow](#development-workflow)
  - [Commands Reference](#commands-reference)
- [Building](#building)
  - [Package Outputs](#package-outputs)
  - [Building Individual Packages](#building-individual-packages)
- [Code Quality](#code-quality)
  - [Commands](#commands)
  - [Formatting Rules](#formatting-rules)
- [Testing](#testing)
- [Releasing](#releasing)
- [Before Committing](#before-committing)
- [Commit Messages](#commit-messages)
- [Code Review Process](#code-review-process)

## Developer Documentation

Before diving into the code, read through the [developer docs](docs/README.md). They cover the architecture, each package's internals, the agent system, database schema, WebSocket protocol, and more.

## How to Contribute

### External Contributors Workflow

We use a **fork-based workflow** for external contributions:

1. **Fork the repository** via the GitHub UI.

2. **Clone your fork**:
   ```bash
   git clone git@github.com:YOUR_USERNAME/system2.git
   cd system2
   ```

3. **Add the upstream repository** as a remote:
   ```bash
   git remote add upstream git@github.com:diegoscarabelli/system2.git
   ```

4. **Create a feature branch** in your fork:
   ```bash
   git checkout -b feature/your-feature-name
   ```

   **Branch naming conventions**:
   - `feature/` - New features or enhancements
   - `fix/` - Bug fixes
   - `docs/` - Documentation updates
   - `refactor/` - Code refactoring

5. **Make your changes** and commit them following the [commit message guidelines](#commit-messages).

6. **Push your branch to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

7. **Create a Pull Request** via GitHub UI.

8. **Keep your fork synchronized** with upstream:
   ```bash
   git fetch upstream
   git checkout main
   git merge upstream/main
   git push origin main
   ```

### Reporting Bugs

When reporting bugs, please include:

- Clear description of the bug
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node.js version, etc.)
- Relevant logs or error messages

### Suggesting Features

When suggesting new features, please include:

- Problem description
- Proposed solution
- Use case and benefits
- Any alternatives you've considered

### Submitting Pull Requests

Before submitting a PR, ensure:

1. Your code follows the formatting standards (see [Code Quality](#code-quality))
2. All quality checks pass: `pnpm check`
3. Tests pass: `pnpm test`
4. Build succeeds: `pnpm build`
5. Documentation is updated if needed — changes to architecture, packages, tools, configuration, or the WebSocket protocol should be reflected in the relevant [docs/](docs/README.md) pages and, where applicable, in [README.md](README.md)

## Development Setup

### Prerequisites

- Node.js >= 20
- pnpm >= 8
- System2 installed globally (`npm install -g @dscarabelli/cli`) and onboarded (`system2 onboard`)

### Initial Setup

Run once after cloning:

```bash
pnpm install
pnpm build
```

### Development Workflow

During development you run two things: the **system2 server** (backend + agent) and the **Vite dev server** (UI hot reload). They run on different ports:

| Process | Port | What it does |
|---------|------|-------------|
| `system2 start` | 3000 | Backend server, WebSocket, agent runtime |
| Vite dev server | 3001 | Serves UI with hot reload, proxies API/artifacts to port 3000 |

**You develop on `localhost:3001`** (not 3000). The Vite dev server proxies WebSocket, artifact, and API requests to the backend automatically.

#### Step-by-step

Open **two terminals** from the repo root:

**Terminal 1 — Start the backend server:**
```bash
system2 start
```

This starts the system2 server on port 3000. Keep it running.

**Terminal 2 — Start the UI dev server with hot reload:**
```bash
cd packages/ui
pnpm dev
```

This starts Vite on `http://localhost:3001`. Open this URL in your browser.

#### What hot reloads and what doesn't

| Change | Hot reload? | What to do |
|--------|------------|------------|
| UI components (`packages/ui/src/`) | Yes | Saves automatically reflect in the browser |
| Server code (`packages/server/src/`) | No | Rebuild and restart: `pnpm build && system2 stop && system2 start` |
| CLI code (`packages/cli/src/`) | No | Rebuild: `pnpm --filter @dscarabelli/cli build` |
| Shared types (`packages/shared/src/`) | No | Rebuild: `pnpm build` (all packages depend on it) |

### Commands Reference

```bash
pnpm build        # Build all packages
pnpm dev          # Run all packages in watch/dev mode (alternative to the two-terminal setup)
pnpm typecheck    # Run TypeScript type checking
pnpm check        # Run format check and lint
pnpm format       # Auto-fix formatting
pnpm test         # Run all tests
pnpm test:watch   # Run tests in watch mode
```

## Building

The monorepo uses [tsup](https://tsup.egoist.dev/) for TypeScript packages and [Vite](https://vite.dev/) for the UI.

```bash
pnpm build        # Build all packages (respects dependency order)
```

Build order: `shared` → `server` + `ui` (parallel) → `cli`

### Package Outputs

| Package | Build tool | Output |
|---------|------------|--------|
| `packages/shared` | tsup | `dist/index.js` - shared types and utilities |
| `packages/server` | tsup | `dist/index.js` - HTTP server and agent runtime |
| `packages/ui` | Vite | `dist/` - static assets (copied to CLI) |
| `packages/cli` | tsup | `dist/index.js` - CLI entry point |

### Building Individual Packages

```bash
pnpm --filter @dscarabelli/server build   # Build only server
pnpm --filter @dscarabelli/cli build      # Build only CLI
```

## Code Quality

This project uses [Biome](https://biomejs.dev/) for formatting and linting.

### Commands

```bash
pnpm format       # Format all files (auto-fix)
pnpm format:check # Check formatting without changes
pnpm lint         # Run linter
pnpm check        # Run both format check and lint
```

### Formatting Rules

- **Line width:** 100 characters
- **Quotes:** Single quotes
- **Indentation:** 2 spaces
- **Trailing commas:** ES5 style
- **Imports:** Use `node:` protocol for Node.js builtins

## Testing

System2 uses [Vitest](https://vitest.dev/) for testing, configured as a workspace across the `server` and `cli` packages.

### Running Tests

```bash
pnpm test         # Run all tests once
pnpm test:watch   # Run tests in watch mode (re-runs on file changes)
```

### Writing Tests

Test files live alongside the source files they test, using the `.test.ts` suffix:

```
packages/server/src/agents/retry.ts        # Source
packages/server/src/agents/retry.test.ts   # Tests
```

When adding new functionality, add tests for any exported logic — especially pure functions, state machines, and data transformations. Tests that touch the filesystem should use `tmpdir()` with cleanup in `afterEach`.

### Testing Patterns

| Category | Pattern | Example tools |
| ---------- | --------- | --------------- |
| Filesystem | Temp dirs with `afterEach` cleanup | `bash`, `read`, `edit`, `write` |
| Database | Mock `DatabaseClient` with inline query/method stubs | `read_system2_db`, `write_system2_db` |
| Agent interaction | Mock `DatabaseClient` + `AgentRegistry`/`AgentSpawner` | `message_agent`, `spawn_agent`, `terminate_agent` |
| Network | Mock global `fetch` | `web_fetch`, `web_search` |
| Artifacts | Real files in `~/.system2/` with cleanup | `show_artifact` |

- **AbortSignal:** tools that accept an `AbortSignal` (e.g. `bash`, `edit`) include tests for pre-aborted signals
- **Streaming:** `bash` tests verify `onUpdate` callback receives partial output
- **Background execution:** `bash` tests verify `notifyBackground` callback delivery

### CI

A GitHub Actions workflow runs on every push and PR. It executes `pnpm check`, `pnpm typecheck`, `pnpm build`, and `pnpm test`. A local pre-push git hook runs the same checks before code leaves your machine.

## Releasing

Packages are published to npm under the `@dscarabelli` scope (private, restricted access). Publishing is automated via GitHub Actions.

### How to release

1. Bump the `version` field in all four `packages/*/package.json` files to the same version.
2. Commit the version bump: `git commit -m "chore: bump version to 0.2.0"`
3. Push to `main`.
4. Go to **GitHub > Releases > Create a new release**.
5. Create a new tag matching the version (e.g., `v0.2.0`), write release notes, and click **Publish release**.
6. The `release.yml` workflow runs automatically: builds, tests, and publishes all packages to npm.

### Adding users

To grant someone install access without exposing source code:

1. Go to **npmjs.com > Your org > Members**.
2. Invite them as a **read-only** member.
3. They run `npm login`, then `npm install -g @dscarabelli/cli`.

## Before Committing

Run the following before every commit:

```bash
pnpm check        # Verify formatting and lint
pnpm build        # Ensure build passes
pnpm test         # Run all tests
```

If `pnpm check` reports issues, fix them with:

```bash
pnpm format       # Auto-fix formatting
pnpm lint         # Review lint warnings
```

## Commit Messages

Write clear, concise commit messages:

- Use present tense ("Add feature" not "Added feature")
- First line: summary under 72 characters
- Reference issues when applicable (e.g., "Fix #123")
- Optionally add a blank line and longer description

Example:
```
Add API key failover support

Implements automatic failover between multiple API keys per provider.
Keys are tried in order until one succeeds.
```

## Code Review Process

1. **Automated checks** run on all PRs (via GitHub Actions)
   - Code formatting and lint (`pnpm check`)
   - Type checking (`pnpm typecheck`)
   - Build verification (`pnpm build`)
   - Test suite (`pnpm test`)
   - Must pass before merge

2. **Manual review** by project maintainers
   - Code quality and style
   - Documentation completeness
   - Architectural fit

3. **Feedback and iteration**
   - Address reviewer comments
   - Make requested changes
   - Push updates to your PR branch

4. **Approval and merge**
   - PRs require approval from a maintainer
   - Your contribution becomes part of the project!

---

Thank you for contributing to System2!
