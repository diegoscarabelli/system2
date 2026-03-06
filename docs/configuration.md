# Configuration

All System2 settings live in `~/.system2/config.toml`, created by `system2 onboard` with `0600` permissions (contains API keys).

**Key source files:**
- `packages/shared/src/types/config.ts` -- TypeScript types
- `packages/cli/src/utils/config.ts` -- TOML loading and validation
- `packages/server/src/agents/auth-resolver.ts` -- failover logic

## config.toml Reference

```toml
# LLM providers and API keys
[llm]
primary = "anthropic"
fallback = ["google", "openai"]

[llm.anthropic]
keys = [
  { key = "sk-ant-...", label = "personal" },
  { key = "sk-ant-...", label = "work" },
]

[llm.google]
keys = [{ key = "AIza...", label = "default" }]

[llm.openai]
keys = [{ key = "sk-...", label = "default" }]

# Service credentials
[services.brave_search]
key = "BSA..."

# Tool settings
[tools.web_search]
enabled = true
max_results = 5

# Operational settings
[backup]
cooldown_hours = 24    # Min hours between auto-backups
max_backups = 5        # Max backup copies to keep

[session]
rotation_threshold_mb = 10  # JSONL session file rotation threshold

[logs]
rotation_threshold_mb = 10  # Log file rotation threshold
max_archives = 5            # Max rotated log files

[scheduler]
daily_summary_interval_minutes = 30  # Narrator summary frequency

[chat]
max_history_messages = 100  # Max messages in chat history ring buffer
```

## Sections

| Section | Description | TypeScript Type |
|---------|-------------|-----------------|
| `[llm]` | Primary provider, fallback order, per-provider keys | `LlmConfig` |
| `[services.*]` | External service credentials | `ServicesConfig` |
| `[tools.*]` | Tool feature flags | `ToolsConfig` |
| `[backup]` | Auto-backup frequency and retention | -- |
| `[session]` | Session file rotation threshold | -- |
| `[logs]` | Log rotation threshold and archive count | -- |
| `[scheduler]` | Narrator job scheduling | `SchedulerConfig` |
| `[chat]` | Chat history settings | `ChatConfig` |

## LLM Providers

| Provider | Models Used |
|----------|------------|
| `anthropic` | Claude (Sonnet, Opus) |
| `google` | Gemini |
| `openai` | GPT, o-series |

Each provider supports multiple labeled keys for rotation. Keys are tried in order until one succeeds.

## Automatic Failover

When API errors occur, System2 automatically retries and fails over:

| Error | Behavior |
|-------|----------|
| **401/403** (auth) | Immediate failover. Key permanently marked failed. |
| **429** (rate limit) | Retry 3x with exponential backoff, then failover. |
| **500/503/timeout** | Retry 2x with exponential backoff, then failover. |
| **400** (bad request) | Surface error to user. No retry or failover. |

**Failover order:**
1. Next key for the current provider
2. First fallback provider's keys
3. Continue through fallback providers

**Cooldown recovery:** Rate limit and transient failures enter a 5-minute cooldown. Keys become available again automatically after cooldown expires. Auth errors (invalid/revoked keys) are permanent until you edit config.toml.

See [Agents](agents.md#authresolver-auth-resolverts) for implementation details.

## Data Directory

```
~/.system2/
├── .git/                  # Version control for text files
├── config.toml            # Settings and credentials (0600)
├── app.db                 # SQLite database
├── chat-history.json      # Chat message ring buffer (max 100)
├── server.pid             # PID file when server is running
├── knowledge/
│   ├── infrastructure.md  # Data stack details (Guide)
│   ├── user.md            # User profile (Guide)
│   ├── memory.md          # Long-term memory (Narrator)
│   └── daily_summaries/   # Activity summaries (Narrator)
├── sessions/              # Agent JSONL session files
├── projects/              # Project workspaces
└── logs/
    ├── system2.log        # Server logs
    └── system2.log.N      # Rotated archives (1-5)
```

Auto-backups: `~/.system2-auto-backup-YYYY-MM-DDTHH-MM-SS/`

## See Also

- [CLI](packages/cli.md) -- `system2 onboard` creates the config
- [Agents](agents.md) -- how LLM config drives provider selection
- [Knowledge System](knowledge-system.md) -- knowledge directory details
- [Scheduler](scheduler.md) -- `daily_summary_interval_minutes`
