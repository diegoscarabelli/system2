# Configuration

All System2 settings live in `~/.system2/config.toml`, created by `system2 onboard` with `0600` permissions (contains API keys).

**Key source files:**
- `src/shared/types/config.ts`: TypeScript types
- `src/cli/utils/config.ts`: TOML loading and validation
- `src/server/agents/auth-resolver.ts`: failover logic

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
google = "gemini-2.5-pro"

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

# Use Gemini 2.5 Pro for the Conductor on Google
[agents.conductor.models]
google = "gemini-2.5-pro"
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
