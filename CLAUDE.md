# CLAUDE.md

This file provides guidance to AI coding agents working with code in this repository. The following sections provide references to other files that must be read before any work to acquire critical knowledge about system2.

## README.md

The [`README.md`](README.md) file is the project's public-facing landing page: what System2 is, key features, quick start, and links to docs.

## CONTRIBUTING.md

The [`CONTRIBUTING.md`](CONTRIBUTING.md) file contains development guidelines. Key sections:

- **How to Contribute**: Fork-based workflow, branch naming conventions, PR process.
- **Development Setup**: Prerequisites (Node.js >= 20, pnpm >= 8) and setup commands.
- **Building**: Build outputs.
- **Code Quality**: Biome formatting/linting rules and commands.
- **Before Committing**: Required quality checks before every commit.
- **Code Review Process**: How PRs are reviewed and merged.

## Developer Documentation

The [`docs/`](docs/) directory contains in-depth documentation. Start with [`docs/README.md`](docs/README.md) for an overview, then refer to individual files as needed:

| File | Description |
| ---- | ----------- |
| [`architecture.md`](docs/architecture.md) | Project structure, runtime components, pi-coding-agent integration |
| [`agents.md`](docs/agents.md) | Multi-agent orchestration, LLM failover, inter-agent messaging |
| [`tools.md`](docs/tools.md) | Custom agent tools: typed parameters, factory pattern, execution |
| [`database.md`](docs/database.md) | SQLite schema, WAL mode, better-sqlite3 usage |
| [`artifacts.md`](docs/artifacts.md) | Published analytical outputs, storage, DB registration, UI rendering, postMessage bridge |
| [`scratchpad.md`](docs/scratchpad.md) | Working area for exploration and prototyping, intermediate data and notebook recommendations, promotion to artifacts |
| [`websocket-protocol.md`](docs/websocket-protocol.md) | Real-time UI–server communication protocol |
| [`knowledge-system.md`](docs/knowledge-system.md) | Persistent knowledge files, git-tracked, dynamic prompt injection |
| [`skills.md`](docs/skills.md) | Reusable agent workflow instructions, SKILL.md format, discovery and injection |
| [`scheduler.md`](docs/scheduler.md) | Cron-based Narrator jobs via Croner |
| [`configuration.md`](docs/configuration.md) | `config.toml` settings and API keys |
| [`cli.md`](docs/cli.md) | CLI: onboarding, daemon management, status |
| [`server.md`](docs/server.md) | Server: HTTP, WebSocket, agents, scheduler |
| [`shared.md`](docs/shared.md) | Shared TypeScript type definitions |
| [`ui.md`](docs/ui.md) | React UI: real-time chat, artifacts |

## Command Reference

```bash
pnpm install              # Install dependencies
pnpm build                # Build the project
pnpm dev                  # Run in dev mode
pnpm check                # Run format check and lint
pnpm format               # Auto-fix formatting
pnpm typecheck            # Run TypeScript type checking
pnpm test                 # Run all tests (vitest)
pnpm test:watch           # Run tests in watch mode
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

## Releasing

`.github/workflows/release.yml` publishes to npm on the `release: published` event, **not on push to main**. A `release: vX.Y.Z` commit on main alone does **not** publish — npm will stay on the prior version until a GitHub Release is cut. This has been forgotten twice (v0.3.8 and v0.3.9 both shipped without a Release and npm sat on v0.3.7 for hours). Follow every step:

1. Pick the next SemVer bump (bug fix = patch, new feature = minor, breaking = major).
2. Stamp `CHANGELOG.md`: rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and add a fresh empty `## [Unreleased]` above it. Entries should describe what changed and why, not just what file moved.
3. Bump `version` in `package.json` to match.
4. Commit on main with `release: vX.Y.Z` and a body summarizing what's shipping (the prior release commits — `git log --grep '^release:'` — set the tone).
5. Push to main (`git push origin main`). The `release: vX.Y.Z` commit is the documented exception to the "always PR" rule because it is text-only.
6. **Cut the GitHub Release** (this is the step that triggers `pnpm publish`):

   ```bash
   awk "/^## \\[X.Y.Z\\]/,/^## \\[/" CHANGELOG.md | sed '$d' > /tmp/notes.md
   gh release create vX.Y.Z --target main --title "vX.Y.Z" --notes-file /tmp/notes.md
   ```

   `--target main` is fine when main's tip is the release commit. If main has already moved past it, create the tag at the historical SHA first (`git tag vX.Y.Z <sha> && git push origin vX.Y.Z`) and then call `gh release create vX.Y.Z` without `--target`.
7. Verify the publish workflow ran and npm has the new version:

   ```bash
   gh run list --workflow=release.yml --limit 1
   npm view @diegoscarabelli/system2 version
   ```
