# Configuration

All System2 settings live in `~/.system2/config.toml`, created by `system2 onboard` with `0600` permissions (contains API keys).

**Key source files:**
- `src/shared/types/config.ts`: TypeScript types
- `src/cli/utils/config.ts`: TOML loading and validation
- `src/server/agents/auth-resolver.ts`: failover logic

## config.toml Reference

```toml
# OAuth tier — subscription credentials, tried first
[llm.oauth]
primary = "anthropic"
fallback = []   # only anthropic OAuth supported in v1

# API key tier — billed per token, used after OAuth tier exhausted
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

# Upstream provider routing for OpenRouter models (optional).
# Keys are model ID prefixes; quote them when they contain special characters (e.g. "/").
# Values are provider order arrays.
[llm.openrouter.routing]
google = ["google-vertex/global", "google-vertex", "google-ai-studio"]

[llm.xai]
keys = [{ key = "xai-...", label = "default" }]

# OpenAI-compatible endpoint (LiteLLM, vLLM, Ollama, Thaura, etc.)
[llm.openai-compatible]
keys = [{ key = "sk-...", label = "default" }]
base_url = "http://localhost:4000/v1"
model = "my-model"
compat_reasoning = true  # optional, default true

# Per-role agent overrides (optional)
# Override thinking_level, compaction_depth, or models for any agent role.
# Only specified fields override the library defaults.
[agents.guide]
thinking_level = "medium"
compaction_depth = 5

[agents.guide.models]
anthropic = "claude-opus-4-6"

[agents.conductor.models]
google = "gemini-3.1-pro-preview"

# Service credentials
[services.brave_search]
key = "BSA..."

# Tool settings
[tools.web_search]
enabled = true
max_results = 5

# Database connections (added during onboarding)
# [databases.my_postgres]
# type = "postgres"
# database = "analytics"
# user = "readonly"

# Operational settings (defaults are fine for most users)
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

[delivery]
max_bytes = 1048576                # Hard cap on inter-agent delivery wire size (~1 MB)
catch_up_budget_bytes = 524288     # Producer budget for catch-up / daily-summary deliveries (~512 KB)
narrator_message_excerpt_bytes = 16384  # Per-custom_message content cap for Narrator-bound deliveries (~16 KB)
```

## Sections

| Section | Description | TypeScript Type |
|---------|-------------|-----------------|
| `[llm]` | Primary provider, fallback order, per-provider keys | `LlmConfig` |
| `[agents.*]` | Per-role agent overrides (models, thinking, compaction) | `AgentsConfig` |
| `[services.*]` | External service credentials | `ServicesConfig` |
| `[tools.*]` | Tool feature flags | `ToolsConfig` |
| `[databases.*]` | External database connections | `DatabasesConfig` |
| `[backup]` | Auto-backup frequency and retention | -- |
| `[session]` | Session file rotation threshold | -- |
| `[logs]` | Log rotation threshold and archive count | -- |
| `[scheduler]` | Narrator job scheduling | `SchedulerConfig` |
| `[chat]` | Chat history settings | `ChatConfig` |
| `[knowledge]` | Knowledge file size budget | `KnowledgeConfig` |
| `[delivery]` | Inter-agent delivery size bounds | -- |

## LLM Providers

| Provider | Models Used |
|----------|------------|
| `anthropic` | Claude (Sonnet, Opus, Haiku); also supports OAuth (Claude Pro/Max) |
| `cerebras` | Fast inference (Llama, Qwen) |
| `google` | Gemini |
| `groq` | Fast inference (Llama, DeepSeek, Gemma) |
| `mistral` | Mistral Large/Medium/Small, Magistral |
| `openai` | GPT, o-series |
| `openai-compatible` | Any OpenAI-compatible endpoint (LiteLLM, vLLM, Ollama, Thaura) |
| `openrouter` | Any model via OpenRouter (uses `provider/model` IDs) |
| `xai` | Grok |

Each provider supports multiple labeled keys for rotation. Keys are tried in order until one succeeds.

## Delivery Size Bounds

To prevent oversized inter-agent deliveries from triggering provider context-overflow errors or cooldown cascades, the `[delivery]` section configures producer-side size limits:

| Setting | Default | Purpose |
|---------|---------|---------|
| `max_bytes` | 1048576 (1 MB) | Hard wire-size cap. Approximately 25% of a 1M-token context window. Producers should self-bound; this is the loud-fail boundary at which deliveries are rejected. |
| `catch_up_budget_bytes` | 524288 (512 KB) | Producer-side budget for catch-up and daily-summary deliveries. Typically half of `max_bytes`, leaving headroom for headers, DB-changes sections, and SDK overhead. When activity exceeds this budget, oldest entries are dropped first. |
| `narrator_message_excerpt_bytes` | 16384 (16 KB) | Per-`custom_message` content cap when feeding session JSONL into Narrator-bound deliveries (daily-summary cron and `trigger_project_story` tool). Prevents individual messages with oversized content from bloating the delivery. |

**Invariant:** `catch_up_budget_bytes` must be less than `max_bytes`. This is validated at startup; if violated, a warning is logged.

When a catch-up delivery (e.g., daily summary) exceeds `catch_up_budget_bytes`, the oldest activity entries are dropped first, with a note prepended: `[NOTE: dropped N oldest entries spanning timestamp-A → timestamp-B to fit within delivery budget]`. The server logs this action at warn level. Cursor advancement is unaffected: the `last_narrator_update_ts` advances to the current run timestamp regardless, so dropped entries are intentionally not re-scanned.

For the `message_agent` tool, if a single message payload exceeds `max_bytes`, it is synchronously rejected with error code `message_too_large`.

The `openrouter` provider supports an optional `[llm.openrouter.routing]` section that controls upstream provider routing. Keys are model ID prefixes matched against the resolved model (longest prefix wins), values are arrays of OpenRouter provider slugs tried in order. Prefixes containing special characters like `/` must be quoted in TOML (e.g. `"google/" = [...]`). For example, `google = ["google-vertex/global", "google-vertex", "google-ai-studio"]` routes all `google/*` models through Vertex AI first. If no prefix matches, no routing preference is set and OpenRouter uses its default load balancing.

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

## Auth Tiers

System2 has two auth tiers:

- **OAuth tier** — subscription credentials (`[llm.oauth]`). Tried first. v1 supports Anthropic Claude Pro/Max OAuth. Pi-ai supports Google Gemini CLI, GitHub Copilot, and OpenAI Codex OAuth as well; those will be added in future iterations.
- **API key tier** — `[llm].primary` + `fallback`. Same shape as today. Used after the OAuth tier is fully exhausted (every OAuth credential in cooldown).

The OAuth tier is fully exhausted before the system drops into the API key tier — never interleaving. If `[llm.oauth]` is absent, system2 behaves exactly like an API-key-only setup.

### Anthropic OAuth (Claude Pro/Max)

The pi-ai SDK detects OAuth tokens (substring match `sk-ant-oat`) and switches the Anthropic client to Bearer auth + Claude Code identity headers. The agent loop, custom tools, and multi-agent orchestration are unchanged.

**Setup:** During `system2 onboard`, the first step asks whether to configure OAuth. Selecting "yes" + "Anthropic" opens a browser for Claude.ai authentication. The resulting tokens are saved to `~/.system2/oauth/anthropic.json` (mode 0600).

**Refresh:** OAuth access tokens expire roughly hourly. The daemon refreshes them automatically before each agent session creation and on 401 errors. Refreshed tokens are persisted back to `~/.system2/oauth/anthropic.json`.

**Failover:** A 401 on an OAuth credential triggers one refresh-and-retry. If refresh succeeds, the session reinitializes with the new token and the prompt retries. If refresh fails (or any other error), the OAuth credential enters cooldown and the next OAuth fallback is tried; once the OAuth tier is exhausted, the system drops into the API key tier.

**Caveats:**
- Claude Pro/Max usage limits are sized for one human in Claude Code. A multi-agent system2 workload (Guide + Conductor + Reviewer + Workers + Narrator running concurrently) can hit the 5-hour message cap quickly. Configure the API key tier as fallback for sustained workloads.
- Programmatic use of Pro/Max credentials outside Claude Code is in a TOS gray area. Use at your own discretion.
- Prompt caching is disabled on the OAuth path (the SDK strips `cache_control` from system prompts for OAuth tokens). Per-call billing still goes through the subscription.

### Re-authenticating and managing credentials post-onboarding

Use `system2 login <provider>` to add an OAuth credential after onboarding (or to re-authenticate when a refresh token has been invalidated — for example, after signing out of Claude.ai, changing your password, revoking the app's grant, or hitting an idle-expiry on the refresh token). The command runs the OAuth flow, writes `~/.system2/oauth/<provider>.json`, and (if `[llm.oauth]` is missing or doesn't include the provider) offers to patch `config.toml` to enable the OAuth tier. If the daemon is running, restart it to pick up the new credential: `system2 stop && system2 start`.

Use `system2 logout <provider>` to remove an OAuth credential. The command deletes the credentials file and offers to remove the provider from `[llm.oauth]` in `config.toml`.

### Changing primary provider or switching auth method

System2 reads `~/.system2/config.toml` only at startup. To change the primary provider, swap which tier is preferred, add or remove a fallback provider, or edit any other LLM configuration:

1. Edit `~/.system2/config.toml` directly (or use `system2 login` / `system2 logout` for OAuth credential changes).
2. Restart the daemon: `system2 stop && system2 start`.

You do not need to switch auth methods manually for cost or rate-limit reasons — the two-tier failover handles that automatically. OAuth is tried first; once exhausted, the system drops to the API key tier without any user action. If a transient failure has put a credential into cooldown and you want to force the system to retry it sooner than the cooldown expiry, restart the daemon (which clears in-memory cooldowns).

## Agent Overrides

Each agent role (guide, conductor, narrator, reviewer, worker) has default settings defined in its library file (`src/server/agents/library/{role}.md`). You can override these defaults per role in config.toml under `[agents.<role>]` sections without modifying the source code.

### Overridable fields

| Field | Type | Description |
|-------|------|-------------|
| `thinking_level` | `off`, `minimal`, `low`, `medium`, `high` | Controls extended thinking depth for the agent's LLM calls |
| `compaction_depth` | integer >= 0 | Number of auto-compactions before pruning old context (0 disables) |
| `models.<provider>` | string | Model ID to use when running on a specific provider |

All fields are optional. Only specified fields override the library defaults; unspecified fields keep their defaults.

### Example

```toml
# Use Opus instead of Sonnet for the Guide on Anthropic
[agents.guide]
thinking_level = "medium"
compaction_depth = 5

[agents.guide.models]
anthropic = "claude-opus-4-6"

# Use Gemini 3.1 Pro for the Conductor on Google
[agents.conductor.models]
google = "gemini-3.1-pro-preview"
```

### How it works

During agent initialization, `AgentHost` reads the library frontmatter first, then applies any matching `[agents.<role>]` overrides from config.toml. For models, the merge is per-provider: `{ ...libraryModels, ...configModels }`. For scalar fields (`thinking_level`, `compaction_depth`), the config value replaces the library default.

This means you can override a single provider's model without affecting the others, or change the thinking level for one role without touching the rest.

## Databases

External database connections are declared as `[databases.<name>]` blocks in config.toml. The name you choose becomes the identifier agents and dashboards use to target that database (for example, the `database` field in the [postMessage bridge](artifacts.md#interactive-dashboards-postmessage-bridge) or the `query_database` tool).

When no database is specified, queries default to `system2`, the internal app.db (SQLite).

### Supported types

| Type | Driver package | Compatible databases |
|------|---------------|---------------------|
| `postgres` | `pg` | PostgreSQL, TimescaleDB, CockroachDB, YugabyteDB, Redshift, AlloyDB, Neon, Supabase |
| `mysql` | `mysql2` | MySQL, MariaDB |
| `sqlite` | `better-sqlite3` | SQLite (opens local file, read-only) |
| `mssql` | `mssql` | SQL Server, Azure SQL |
| `clickhouse` | `@clickhouse/client` | ClickHouse (HTTP protocol) |
| `duckdb` | `duckdb` | DuckDB, MotherDuck (via `md:` prefix) |
| `snowflake` | `snowflake-sdk` | Snowflake |
| `bigquery` | `@google-cloud/bigquery` | Google BigQuery |

More types can be added by implementing a driver adapter.

### Driver installation

Database drivers are not bundled with System2. The Guide installs the required driver packages during onboarding into `~/.system2/node_modules/` based on the database types declared in config.toml. If you add a new database type after onboarding, the Guide will install the missing driver on next startup.

### Credentials

For adapters that use traditional host/user/password connections (postgres, mysql, mssql, clickhouse), passwords can be stored directly in config.toml via the `password` field. Since config.toml is created with `0600` permissions and gitignored, this is safe for personal use. Alternatively, each driver also supports its native credential mechanism as a fallback when no `password` is configured:

| Type | Credential source |
|------|------------------|
| `postgres` | `password` field in config.toml, `~/.pgpass`, or `PGPASSWORD` env var |
| `mysql` | `password` field in config.toml, `~/.my.cnf` `[client]` section, or `MYSQL_PWD` env var |
| `sqlite` | No credentials needed |
| `mssql` | `password` field in config.toml, environment variables (`MSSQL_PASSWORD`), or Azure AD |
| `clickhouse` | `password` field in config.toml, or server-side default credentials |
| `duckdb` | No credentials needed (local files); `MOTHERDUCK_TOKEN` env var for MotherDuck |
| `snowflake` | `SNOWFLAKE_PASSWORD` env var, key-pair via `credentials_file`, or `~/.snowflake/connections.toml` |
| `bigquery` | `credentials_file` (service account JSON), `GOOGLE_APPLICATION_CREDENTIALS` env var, or gcloud ADC |

When the `password` field is omitted, drivers fall back to their native credential mechanisms (env vars, credential files, etc.).

### Configuration fields

**Common fields** (all types):

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `type` | yes | -- | Database type (see supported types table) |
| `database` | yes | -- | Database name, file path (sqlite/duckdb), or dataset (bigquery) |
| `host` | no | `localhost` | Server hostname or IP (postgres, mysql, mssql, clickhouse) |
| `port` | no | Driver default | Server port (postgres: 5432, mysql: 3306, mssql: 1433, clickhouse: 8123) |
| `user` | no | Current OS user | Authentication user |
| `password` | no | -- | Authentication password (postgres, mysql, mssql, clickhouse) |
| `socket` | no | -- | Unix domain socket path, overrides host/port (postgres, mysql) |
| `ssl` | no | `false` | Enable SSL/TLS (postgres, mysql, mssql, clickhouse) |
| `query_timeout` | no | `30` | Query timeout in seconds |
| `max_rows` | no | `10000` | Maximum rows returned per query |

**Snowflake-specific fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `account` | yes | -- | Account identifier (e.g. `xy12345.us-east-1`) |
| `warehouse` | no | -- | Compute warehouse |
| `role` | no | -- | Security role |
| `schema` | no | -- | Default schema |
| `credentials_file` | no | -- | Path to private key file (key-pair auth) |

**BigQuery-specific fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `project` | yes | -- | GCP project ID |
| `credentials_file` | no | -- | Path to service account JSON (falls back to ADC) |

For postgres and mysql, `host`, `port`, `database`, and `user` follow the same semantics as the native client tools (`psql`, `mysql`). For sqlite and duckdb, `database` is the file path. For bigquery, `database` is the dataset name.

### Example configurations

```toml
# PostgreSQL (also works for TimescaleDB, CockroachDB, etc.)
[databases.analytics]
type = "postgres"
database = "analytics"
user = "analyst"

# PostgreSQL: remote server with custom timeout
[databases.warehouse]
type = "postgres"
host = "db.example.com"
port = 5432
database = "warehouse"
user = "readonly"
password = "s3cret"
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
database = "/Users/me/data/survey.db"

# SQL Server
[databases.reporting]
type = "mssql"
host = "sql.example.com"
port = 1433
database = "reporting"
user = "reader"
ssl = true

# ClickHouse
[databases.events]
type = "clickhouse"
host = "clickhouse.internal"
port = 8123
database = "events"
user = "default"

# DuckDB: local file
[databases.parquet_analysis]
type = "duckdb"
database = "/Users/me/data/analysis.duckdb"

# DuckDB: MotherDuck (cloud)
[databases.motherduck]
type = "duckdb"
database = "md:my_database"

# Snowflake
[databases.snowflake_wh]
type = "snowflake"
account = "xy12345.us-east-1"
database = "ANALYTICS"
warehouse = "COMPUTE_WH"
user = "analyst"
role = "ANALYST"
schema = "PUBLIC"

# BigQuery
[databases.bq_analytics]
type = "bigquery"
project = "my-project-123"
database = "my_dataset"
credentials_file = "/path/to/service-account.json"
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

- [CLI](cli.md): `system2 onboard` creates the config
- [Agents](agents.md): how LLM config drives provider selection
- [Knowledge System](knowledge-system.md): knowledge directory details and file size budget
- [Scheduler](scheduler.md): `daily_summary_interval_minutes`
