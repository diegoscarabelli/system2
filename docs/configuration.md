# Configuration

All System2 settings live in `~/.system2/config.toml`, created by `system2 onboard` with `0600` permissions (contains API keys).

**Key source files:**
- `packages/shared/src/types/config.ts`: TypeScript types
- `packages/cli/src/utils/config.ts`: TOML loading and validation
- `packages/server/src/agents/auth-resolver.ts`: failover logic

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

[llm.cerebras]
keys = [{ key = "csk-...", label = "default" }]

[llm.google]
keys = [{ key = "AIza...", label = "default" }]

[llm.groq]
keys = [{ key = "gsk_...", label = "default" }]

[llm.mistral]
keys = [{ key = "...", label = "default" }]

[llm.openai]
keys = [{ key = "sk-...", label = "default" }]

[llm.openrouter]
keys = [{ key = "sk-or-...", label = "default" }]

[llm.xai]
keys = [{ key = "xai-...", label = "default" }]

# OpenAI-compatible endpoint (LiteLLM, vLLM, Ollama, Thaura, etc.)
[llm.openai-compatible]
keys = [{ key = "sk-...", label = "default" }]
base_url = "http://localhost:4000/v1"
model = "my-model"
compat_reasoning = true  # optional, default true

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
max_backups = 3        # Max backup copies to keep

[session]
rotation_threshold_mb = 10  # JSONL session file rotation threshold

[logs]
rotation_threshold_mb = 10  # Log file rotation threshold
max_archives = 5            # Max rotated log files

[scheduler]
daily_summary_interval_minutes = 30  # Narrator summary frequency

[chat]
max_history_messages = 1000  # Max messages in chat history ring buffer

[knowledge]
budget_chars = 20000  # Max chars per knowledge file; Narrator condenses overruns
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
| `[knowledge]` | Knowledge file size budget | `KnowledgeConfig` |
| `[databases.*]` | External database connections | `DatabasesConfig` |

## LLM Providers

| Provider | Models Used |
|----------|------------|
| `anthropic` | Claude (Sonnet, Opus, Haiku) |
| `cerebras` | Fast inference (Llama, Qwen) |
| `google` | Gemini |
| `groq` | Fast inference (Llama, DeepSeek, Gemma) |
| `mistral` | Mistral Large/Medium/Small, Magistral |
| `openai` | GPT, o-series |
| `openai-compatible` | Any OpenAI-compatible endpoint (LiteLLM, vLLM, Ollama, Thaura) |
| `openrouter` | Any model via OpenRouter (uses `provider/model` IDs) |
| `xai` | Grok |

Each provider supports multiple labeled keys for rotation. Keys are tried in order until one succeeds.

The `openai-compatible` provider requires `base_url` and `model` fields in addition to keys. Use it for self-hosted proxies or providers not listed above. The optional `compat_reasoning` field (default `true`) declares whether the model supports extended thinking. For built-in providers (anthropic, openai, etc.), the SDK already knows which models support reasoning; `compat_reasoning` only applies to `openai-compatible` since the SDK has no way to know the capabilities of an arbitrary endpoint. Setting it to `true` for a model that doesn't support reasoning is safe: the SDK only sends `reasoning_effort` when the provider's compatibility layer confirms support, and most backends ignore unknown parameters.

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

## Databases

External database connections are declared as `[databases.<name>]` blocks in config.toml. The name you choose becomes the identifier agents and dashboards use to target that database (for example, the `database` field in the [postMessage bridge](artifacts.md#interactive-dashboards-postmessage-bridge) or the `query_database` tool).

When no database is specified, queries default to `system2`, the internal app.db (SQLite).

### Supported types

| Type | Driver package | Notes |
|------|---------------|-------|
| `postgres` | `pg` | Connects via `libpq` conventions |
| `mysql` | `mysql2` | Connects via standard MySQL protocol |
| `sqlite` | `better-sqlite3` | Opens a local file by `path` |

More types can be added by implementing a driver adapter. The set above covers the initial release.

### Driver installation

Database drivers are not bundled with System2. The Guide installs the required driver packages during onboarding into `~/.system2/node_modules/` based on the database types declared in config.toml. If you add a new database type after onboarding, the Guide will install the missing driver on next startup.

### Credentials

Database credentials are **not** stored in config.toml. Each driver uses its native credential location:

| Type | Credential source |
|------|------------------|
| `postgres` | `~/.pgpass` (or `PGPASSWORD` env var) |
| `mysql` | `~/.my.cnf` `[client]` section (or `MYSQL_PWD` env var) |
| `sqlite` | No credentials needed |

This keeps secrets out of config.toml entirely, relying on well-established credential mechanisms that users and ops teams already know.

### Configuration fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `type` | yes | -- | Database type: `postgres`, `mysql`, or `sqlite` |
| `host` | no | `localhost` | Server hostname or IP (postgres, mysql) |
| `port` | no | Driver default (5432/3306) | Server port (postgres, mysql) |
| `database` | no | -- | Database name to connect to (postgres, mysql) |
| `user` | no | Current OS user | Authentication user (postgres, mysql) |
| `path` | no | -- | File path for sqlite databases |
| `query_timeout` | no | `30` | Query timeout in seconds |
| `max_rows` | no | `10000` | Maximum rows returned per query |

For postgres and mysql, `host`, `port`, `database`, and `user` follow the same semantics as the native client tools (`psql`, `mysql`). For sqlite, only `path` is needed.

### Example configurations

```toml
# PostgreSQL: local server via unix socket (default host/port)
[databases.analytics]
type = "postgres"
database = "analytics"
user = "analyst"

# PostgreSQL: remote server
[databases.warehouse]
type = "postgres"
host = "db.example.com"
port = 5432
database = "warehouse"
user = "readonly"
query_timeout = 60
max_rows = 50000

# MySQL
[databases.legacy]
type = "mysql"
host = "mysql.internal"
port = 3306
database = "legacy_app"
user = "reader"

# SQLite: external database file
[databases.survey_results]
type = "sqlite"
path = "~/data/survey.db"
```

## Application Directory

Config-relevant paths within `~/.system2/` (see [Architecture](architecture.md#runtime-architecture) for the full directory layout):

```
~/.system2/
├── config.toml            # Settings and credentials (0600, gitignored)
├── app.db                 # SQLite database (gitignored)
├── server.pid             # PID file when server is running
├── sessions/              # Agent JSONL session files (gitignored)
└── logs/                  # Server logs (gitignored)
    ├── system2.log
    └── system2.log.N      # Rotated archives (1-5)
```

Auto-backups: `~/.system2-auto-backup-YYYY-MM-DDTHH-MM-SS/`

## See Also

- [CLI](packages/cli.md): `system2 onboard` creates the config
- [Agents](agents.md): how LLM config drives provider selection
- [Knowledge System](knowledge-system.md): knowledge directory details and file size budget
- [Scheduler](scheduler.md): `daily_summary_interval_minutes`
