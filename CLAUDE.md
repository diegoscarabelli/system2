# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## README.md

The [`README.md`](README.md) file contains essential project information:
- **Project overview**: System2 is an AI multi-agent system for working with data.
- **Quickstart**: Installation via npm and basic usage commands.
- **Monorepo structure**: Four packages (cli, server, shared, ui).

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
