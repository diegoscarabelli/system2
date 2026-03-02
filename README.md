# System2

A single-user, self-hosted multi-agent data platform for solo analysts.

## Overview

System2 is an AI data team that automates the full data lifecycle - from data engineering (procurement, transformation, loading) to analysis, reporting, and dashboards. Built on a multi-agent architecture with structured memory and narrative lineage.

## Installation

```bash
# Install globally
npm install -g system2
# or
pnpm install -g system2

# Onboard (creates ~/.system2/, configures LLM providers, launches UI)
system2 onboard

# Start the daemon (subsequent runs)
system2 start
```

## Architecture

- **Multi-agent system**: Guide (user-facing), Conductor (project orchestrator), and specialized data agents
- **Hybrid onboarding**: Terminal prompts for API keys, then agent-guided infrastructure setup
- **Narrative lineage**: No graph database - context captured in readable narration.md files
- **Statistical rigor**: Built-in checking for p-hacking, multiple comparisons, proper intervals

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Start development mode
pnpm dev

# Type checking
pnpm typecheck
```

## Monorepo Structure

```
system2/
├── packages/
│   ├── cli/        # CLI entry point
│   ├── gateway/    # HTTP/WebSocket server + agent host
│   ├── shared/     # Shared TypeScript types
│   └── ui/         # React chat UI
```
