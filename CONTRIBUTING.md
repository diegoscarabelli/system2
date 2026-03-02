# Contributing to System2

## Prerequisites

- Node.js >= 18
- pnpm >= 8

## Setup

```bash
pnpm install
pnpm build
```

## Development

```bash
pnpm dev          # Run all packages in dev mode
pnpm build        # Build all packages
pnpm typecheck    # Run TypeScript type checking
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

### Rules

- **Line width:** 100 characters
- **Quotes:** Single quotes
- **Indentation:** 2 spaces
- **Trailing commas:** ES5 style
- **Imports:** Use `node:` protocol for Node.js builtins

## Before Committing

Run the following before every commit:

```bash
pnpm check        # Verify formatting and lint
pnpm build        # Ensure build passes
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
- Optionally add a blank line and longer description

Example:
```
Add API key failover support

Implements automatic failover between multiple API keys per provider.
Keys are tried in order until one succeeds.
```
