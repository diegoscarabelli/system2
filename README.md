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

## Authentication

System2 stores LLM provider credentials in `~/.system2/auth.json`. Run `system2 onboard` to configure interactively, or edit the file directly:

```json
{
  "version": 1,
  "primary": "anthropic",
  "fallback": ["google", "openai"],
  "providers": {
    "anthropic": {
      "keys": [
        { "key": "sk-ant-...", "label": "personal" },
        { "key": "sk-ant-...", "label": "work" }
      ]
    },
    "google": {
      "keys": [{ "key": "AIza...", "label": "default" }]
    },
    "openai": {
      "keys": [{ "key": "sk-...", "label": "default" }]
    }
  }
}
```

### Supported Providers

| Provider | Models |
|----------|--------|
| `anthropic` | Claude (Sonnet, Opus) |
| `google` | Gemini |
| `openai` | GPT, o-series |

### Automatic Failover

When API errors occur, System2 automatically retries and fails over to alternate keys or providers:

| Error | Behavior |
|-------|----------|
| **401/403** (auth) | Immediate failover - key is permanently marked failed |
| **429** (rate limit) | Retry 3x with exponential backoff, then failover |
| **500/503/timeout** | Retry 2x with exponential backoff, then failover |
| **400** (bad request) | Surface error to user (no retry) |

**Failover order:**
1. Try next key for the current provider
2. If no keys remain, try the first fallback provider
3. Continue through fallback providers in order

**Cooldown recovery:** Keys that fail due to rate limits or transient errors enter a 5-minute cooldown and become available again automatically. Auth errors (invalid/revoked keys) are permanent until you update `auth.json`.

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
│   ├── server/     # HTTP/WebSocket server + agent host
│   ├── shared/     # Shared TypeScript types
│   └── ui/         # React chat UI
```
