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
  - [Setup](#setup)
  - [Development Commands](#development-commands)
- [Building](#building)
  - [Package Outputs](#package-outputs)
  - [Building Individual Packages](#building-individual-packages)
- [Code Quality](#code-quality)
  - [Commands](#commands)
  - [Formatting Rules](#formatting-rules)
- [Before Committing](#before-committing)
- [Commit Messages](#commit-messages)
- [Code Review Process](#code-review-process)

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
3. Build succeeds: `pnpm build`
4. Documentation is updated if needed

## Development Setup

### Prerequisites

- Node.js >= 18
- pnpm >= 8

### Setup

```bash
pnpm install
pnpm build
```

### Development Commands

```bash
pnpm dev          # Run all packages in dev mode
pnpm build        # Build all packages
pnpm typecheck    # Run TypeScript type checking
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
pnpm --filter @system2/server build   # Build only server
pnpm --filter @system2/cli build      # Build only CLI
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
- Reference issues when applicable (e.g., "Fix #123")
- Optionally add a blank line and longer description

Example:
```
Add API key failover support

Implements automatic failover between multiple API keys per provider.
Keys are tried in order until one succeeds.
```

## Code Review Process

1. **Automated checks** run on all PRs
   - Code formatting verification
   - Build verification
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
