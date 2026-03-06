# Development

Guide for setting up a development environment, building, and contributing to System2.

## Prerequisites

- **Node.js** >= 18
- **pnpm** >= 8
- At least one LLM provider API key (see [Configuration](configuration.md))

## Initial Setup

```bash
git clone git@github.com:diegoscarabelli/system2.git
cd system2
pnpm install
pnpm build
```

## Development Workflow

Run two processes: the backend server and the Vite dev server for UI hot reload.

| Process | Port | Purpose |
|---------|------|---------|
| `system2 start` | 3000 | Backend: HTTP, WebSocket, agents, scheduler |
| Vite dev server | 3001 | UI with hot reload, proxies to port 3000 |

**You develop on `localhost:3001`** (not 3000). Vite proxies WebSocket, artifact, and API requests to the backend automatically.

### Step-by-Step

**Terminal 1 -- backend:**
```bash
system2 start
```

**Terminal 2 -- UI dev server:**
```bash
cd packages/ui
pnpm dev
```

### What Hot Reloads

| Change | Auto-reload? | Action Required |
|--------|-------------|-----------------|
| UI components (`packages/ui/src/`) | Yes | Instant in browser |
| Server code (`packages/server/src/`) | No | `pnpm build && system2 stop && system2 start` |
| CLI code (`packages/cli/src/`) | No | `pnpm --filter @system2/cli build` |
| Shared types (`packages/shared/src/`) | No | `pnpm build` (all packages depend on it) |

## Build System

| Package | Tool | Output |
|---------|------|--------|
| `@system2/shared` | [tsup](https://tsup.egoist.dev/) | `dist/index.js` |
| `@system2/server` | [tsup](https://tsup.egoist.dev/) | `dist/index.js` |
| `@system2/ui` | [Vite](https://vite.dev/) | `dist/` static assets |
| `@system2/cli` | [tsup](https://tsup.egoist.dev/) | `dist/index.js` |

**Build order:** `shared` -> `server` + `ui` (parallel) -> `cli`

```bash
pnpm build                             # Build all packages
pnpm --filter @system2/server build    # Build one package
```

## Code Quality

System2 uses [Biome](https://biomejs.dev/) for formatting and linting.

### Rules

- **Line width:** 100 characters
- **Quotes:** Single quotes
- **Indentation:** 2 spaces
- **Trailing commas:** ES5 style
- **Imports:** Use `node:` protocol for Node.js builtins

### Commands

```bash
pnpm check       # Format check + lint (CI runs this)
pnpm format      # Auto-fix formatting
pnpm typecheck   # TypeScript type checking
```

## Before Committing

**Mandatory** before every commit:

```bash
pnpm check    # Verify formatting and lint
pnpm build    # Ensure build passes
```

If `pnpm check` reports issues, run `pnpm format` to auto-fix.

## Contributing

System2 uses a **fork-based workflow**:

1. Fork the repository
2. Clone your fork and add upstream remote
3. Create a feature branch (`feature/`, `fix/`, `docs/`, `refactor/`)
4. Make changes, ensure quality checks pass
5. Push to your fork and open a Pull Request

### Commit Messages

- Present tense ("Add feature" not "Added feature")
- Summary under 72 characters
- Reference issues when applicable ("Fix #123")

### PR Requirements

- `pnpm check` passes
- `pnpm build` passes
- Documentation updated if needed
- Review by project maintainer

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the complete guide.

## Commands Reference

```bash
pnpm install      # Install dependencies
pnpm build        # Build all packages
pnpm dev          # Run all packages in watch/dev mode
pnpm check        # Format check + lint
pnpm format       # Auto-fix formatting
pnpm typecheck    # TypeScript type checking
```

## See Also

- [Architecture](architecture.md) -- monorepo structure and package dependencies
- [Configuration](configuration.md) -- config.toml setup
