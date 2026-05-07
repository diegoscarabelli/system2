---
name: editing-config-toml
description: Use when editing `~/.system2/config.toml` — adding or modifying a database connection, tuning per-agent overrides, or changing operational defaults. Does NOT cover `~/.system2/auth/.auth.toml` (managed by `system2 config`).
roles: [guide, conductor, worker]
---

# Editing `~/.system2/config.toml`

Reference for hand-editing the System2 operational config file. Covers the per-adapter database schema (the most structured part) and a short reference for the other sections.

## Purpose and file split

`~/.system2/config.toml` holds **operational settings**, edited by hand:

- Per-agent behavior overrides (`[agents.<role>]`).
- External database connections (`[databases.<name>]`) used by the `query_database` agent tool and by dashboard artifacts.
- Operational tunables (backup cadence, log rotation, scheduler intervals, session/delivery sizes, etc.) — most stay commented at code defaults.

`~/.system2/auth/.auth.toml` holds **credentials** and is managed exclusively by `system2 config`:

- LLM credentials: `[llm.oauth]` (Anthropic, OpenAI Codex, GitHub Copilot) and `[llm.api_keys]` (Anthropic, OpenAI, Google, etc.).
- Service credentials: `[services.brave_search]`.
- The `[tools.web_search].enabled` flag.

**Never** put LLM or service credentials in `config.toml` — the loader does not read them from there. **Database passwords are an exception**: they belong in `config.toml` on the matching `[databases.<name>].password` field. The file is created with `0600` permissions, and `config.toml` (alongside `auth/` and the legacy `oauth/`) is listed in `~/.system2/.gitignore` so it isn't committed to the internal git repo System2 maintains for knowledge-file version control. Personal-use storage is safe. If you prefer, leave `password` unset and rely on the driver's native fallback (e.g. `~/.pgpass`, `~/.my.cnf`, `MYSQL_PWD`).

## Editing protocol

Follow this protocol for every edit:

1. **Read first**, always: `read ~/.system2/config.toml`. Never edit blind.
2. **Use `edit`, not `write`**: `write` replaces the entire file and destroys other sections (per-agent overrides, other databases, operational defaults). `edit` does targeted string replacement.
3. **Never use `append: true`**: it dumps content at the bottom, far from the right section header. Always edit in place at the correct location.
4. **Place new database blocks immediately after the commented `[databases.mydb]` example**, keeping all `[databases.<name>]` sections grouped.
5. **Restart the daemon** after any edit (`system2 stop && system2 start`). The daemon reads config at startup; live edits don't apply until restart.

`config.toml` is gitignored inside `~/.system2/`'s internal git repo (created automatically by the daemon for knowledge-file version control). Edits are local-only — they don't get committed by accident.

## Database connections

The most structured section of the file. This is what agents add to enable `query_database` and dashboard data access.

### Purpose

`[databases.<name>]` blocks tell System2's server how to connect to **read-only** data sources:

- **Agents** use them via the `query_database` tool to run analytical queries.
- **Dashboard HTML artifacts** query them via the postMessage bridge: the artifact sends `system2:query` with the database name, the server runs the query through the appropriate adapter, and the result comes back as `system2:query_result`. Allowed query forms: `SELECT`, `WITH ... SELECT` (CTEs), and `EXPLAIN`. Mutations are rejected.

**Pipelines do NOT use these entries.** Pipelines manage their own database connections (typically with a write user); System2 only reads. Use a **read-only** database user (not the pipeline's write user) for `[databases.<name>]` entries.

The reserved name `system2` is the built-in app database (`~/.system2/app.db`, holds System2's metadata). Never create a `[databases.system2]` section — it is silently ignored.

### Complementarity with `infrastructure.md`

`~/.system2/knowledge/infrastructure.md` is the **broader inventory** of all databases in the user's data stack: write users, read users, where credential JSON files live, deployment locations (local vs remote), etc. It's a knowledge file maintained during onboarding and updated as the stack evolves.

`[databases.<name>]` blocks in `config.toml` are the **read-only subset** that System2 itself needs to query. When adding a new connection here, refer to `infrastructure.md` for credential context (which read-only user, where the password is stored). When discovering or installing a new database during onboarding, write the broader description to `infrastructure.md` first, then write the System2-specific read-only block here.

### Driver install

Database drivers are not bundled with System2. Install the driver for each database type into `~/.system2/node_modules/`:

```bash
npm install --prefix ~/.system2 pg                    # PostgreSQL, TimescaleDB, CockroachDB
npm install --prefix ~/.system2 mysql2                 # MySQL, MariaDB
npm install --prefix ~/.system2 mssql                  # SQL Server, Azure SQL
npm install --prefix ~/.system2 @clickhouse/client     # ClickHouse
npm install --prefix ~/.system2 duckdb                 # DuckDB, MotherDuck
npm install --prefix ~/.system2 snowflake-sdk          # Snowflake
npm install --prefix ~/.system2 @google-cloud/bigquery # BigQuery
# SQLite: no install needed (better-sqlite3 ships with System2)
```

Drivers are dynamically loaded on first use, so installing the right one for each `type` value in your config is required.

### Per-adapter reference

Required fields are validated by the loader and rejected at startup with a precise diagnostic if missing. Optional fields fall back to driver defaults or native credential mechanisms.

The field tables and credential-fallback table below are auto-generated from `src/shared/types/databases-schema.ts` (the single source of truth for validation and documentation). Do not edit content between `<!-- BEGIN auto-generated:* -->` markers by hand — when the schema changes, run `pnpm generate:db-reference` and commit the regenerated content. CI fails if the on-disk content drifts from the schema.

#### `postgres` — PostgreSQL (also TimescaleDB, CockroachDB, other Postgres-wire-compatible servers)

<!-- BEGIN auto-generated:fields:postgres -->

| Field | Required | Notes |
|-------|----------|-------|
| `database` | yes | Database name |
| `host` | no | Defaults to `localhost` |
| `max_rows` | no | Per-query row cap; defaults `10000`, max `1000000` |
| `password` | no | Falls back to `~/.pgpass`, `PGPASSWORD` env var |
| `port` | no | Defaults to `5432` |
| `query_timeout` | no | Seconds; defaults `30` |
| `socket` | no | Unix domain socket path; overrides host/port |
| `ssl` | no | Enable SSL/TLS; defaults `false` |
| `user` | no | Defaults to current OS user |

<!-- END auto-generated:fields:postgres -->

```toml
[databases.analytics]
type = "postgres"
host = "localhost"
port = 5432
database = "analytics"
user = "readonly"
password = "secret"
```

#### `mysql` — MySQL or MariaDB

<!-- BEGIN auto-generated:fields:mysql -->

| Field | Required | Notes |
|-------|----------|-------|
| `database` | yes | Database name |
| `host` | no | Defaults to `localhost` |
| `max_rows` | no | Per-query row cap; defaults `10000`, max `1000000` |
| `password` | no | Falls back to `~/.my.cnf` `[client]` section, `MYSQL_PWD` env var |
| `port` | no | Defaults to `3306` |
| `query_timeout` | no | Seconds; defaults `30` |
| `socket` | no | Unix domain socket path |
| `ssl` | no | Enable SSL/TLS; defaults `false` |
| `user` | no | Defaults to current OS user |

<!-- END auto-generated:fields:mysql -->

```toml
[databases.legacy]
type = "mysql"
host = "mysql.internal"
port = 3306
database = "legacy_app"
user = "reader"
password = "secret"
```

#### `mssql` — Microsoft SQL Server (via tedious driver)

<!-- BEGIN auto-generated:fields:mssql -->

| Field | Required | Notes |
|-------|----------|-------|
| `database` | yes | Database name |
| `password` | yes | Required (no native fallback for tedious) |
| `user` | yes | Required (no native fallback for tedious) |
| `host` | no | Defaults to `localhost` |
| `max_rows` | no | Per-query row cap; defaults `10000`, max `1000000` |
| `port` | no | Defaults to `1433` |
| `query_timeout` | no | Seconds; defaults `30` |
| `ssl` | no | Controls `encrypt`; defaults `false` |

<!-- END auto-generated:fields:mssql -->

```toml
[databases.warehouse]
type = "mssql"
host = "sql.example.com"
port = 1433
database = "warehouse"
user = "reader"
password = "secret"
ssl = true
```

#### `clickhouse` — ClickHouse over HTTP/HTTPS

<!-- BEGIN auto-generated:fields:clickhouse -->

| Field | Required | Notes |
|-------|----------|-------|
| `database` | yes | Database name |
| `host` | no | Defaults to `localhost` |
| `max_rows` | no | Per-query row cap; defaults `10000`, max `1000000` |
| `password` | no | Defaults to empty (the `default` user typically has empty password) |
| `port` | no | Defaults to `8123` (HTTP) or `8443` (HTTPS) |
| `query_timeout` | no | Seconds; defaults `30` |
| `ssl` | no | Selects `https` protocol |
| `user` | no | Defaults to `default` |

<!-- END auto-generated:fields:clickhouse -->

```toml
[databases.events]
type = "clickhouse"
host = "ch.example.com"
port = 8443
database = "events"
user = "reader"
password = "secret"
ssl = true
```

#### `snowflake` — Snowflake (basic auth or key-pair auth)

<!-- BEGIN auto-generated:fields:snowflake -->

| Field | Required | Notes |
|-------|----------|-------|
| `account` | yes | Account identifier (e.g. `xy12345.us-east-1`) |
| `user` | yes | Authentication username |
| `credentials_file` | one-of | Path to PEM private key (key-pair auth alternative to password) |
| `password` | one-of | Basic auth password |
| `database` | no | Default database (sessions can issue `USE database` per-query) |
| `max_rows` | no | Per-query row cap; defaults `10000`, max `1000000` |
| `query_timeout` | no | Seconds; defaults `30` |
| `role` | no | Default security role |
| `schema` | no | Default schema |
| `warehouse` | no | Default virtual warehouse |

<!-- END auto-generated:fields:snowflake -->

```toml
# Basic auth
[databases.snow_basic]
type = "snowflake"
account = "xy12345.us-east-1"
user = "analyst"
password = "secret"
warehouse = "COMPUTE_WH"
database = "ANALYTICS"
role = "ANALYST"

# Key-pair auth
[databases.snow_keypair]
type = "snowflake"
account = "xy12345.us-east-1"
user = "analyst"
credentials_file = "/path/to/rsa_key.p8"
warehouse = "COMPUTE_WH"
database = "ANALYTICS"
```

A snowflake entry with neither `password` nor `credentials_file` is rejected at startup with: `snowflake requires either "password" (basic auth) or "credentials_file" (key-pair auth)`.

#### `bigquery` — Google BigQuery

<!-- BEGIN auto-generated:fields:bigquery -->

| Field | Required | Notes |
|-------|----------|-------|
| `database` | yes | BigQuery dataset name |
| `project` | yes | GCP project ID |
| `credentials_file` | no | Path to service-account JSON. Falls back to ADC (`GOOGLE_APPLICATION_CREDENTIALS` env var or `gcloud auth application-default login`) |
| `max_rows` | no | Per-query row cap; defaults `10000`, max `1000000` |
| `query_timeout` | no | Seconds; defaults `30` |

<!-- END auto-generated:fields:bigquery -->

```toml
[databases.bq]
type = "bigquery"
project = "my-project-123"
database = "my_dataset"
credentials_file = "/path/to/service-account.json"
```

#### `sqlite` — Local SQLite file (read-only)

<!-- BEGIN auto-generated:fields:sqlite -->

| Field | Required | Notes |
|-------|----------|-------|
| `database` | yes | Filepath to the `.db`/`.sqlite`/`.sqlite3` file |
| `max_rows` | no | Per-query row cap; defaults `10000`, max `1000000` |

<!-- END auto-generated:fields:sqlite -->

```toml
[databases.local_sqlite]
type = "sqlite"
database = "/path/to/data.db"
```

#### `duckdb` — Local DuckDB file (or MotherDuck)

<!-- BEGIN auto-generated:fields:duckdb -->

| Field | Required | Notes |
|-------|----------|-------|
| `database` | yes | Filepath, or `:memory:`, or `md:<dbname>` for MotherDuck |
| `max_rows` | no | Per-query row cap; defaults `10000`, max `1000000` |
| `query_timeout` | no | Seconds; defaults `30` |

<!-- END auto-generated:fields:duckdb -->

```toml
[databases.duck]
type = "duckdb"
database = "/path/to/analysis.duckdb"

# MotherDuck (set MOTHERDUCK_TOKEN env var)
[databases.md]
type = "duckdb"
database = "md:my_md_db"
```

### Credential handling summary

<!-- BEGIN auto-generated:credential-fallback -->

| `type` | Credential fallback when `password` (or its equivalent) is omitted |
|---|---|
| `postgres` | `~/.pgpass`, `PGPASSWORD` env var |
| `mysql` | `~/.my.cnf` `[client]` section, `MYSQL_PWD` env var |
| `mssql` | No native fallback; `password` is required. |
| `clickhouse` | Server-side default credentials (driver defaults to user `default` with empty password). |
| `snowflake` | Either `password` (basic auth) or `credentials_file` pointing at a private key (key-pair auth) must be set in the TOML. The schema rejects entries with neither at startup, so the snowflake-sdk `SNOWFLAKE_PASSWORD` env-var fallback is not reachable through this loader. |
| `bigquery` | Application Default Credentials (ADC) via `gcloud auth application-default login`, or `GOOGLE_APPLICATION_CREDENTIALS` env var. |
| `sqlite` | No credentials needed (local file). |
| `duckdb` | No credentials needed (local file). For MotherDuck, set `MOTHERDUCK_TOKEN` env var. |

<!-- END auto-generated:credential-fallback -->

### Verifying and troubleshooting

After saving an edit and restarting the daemon (per the editing protocol above), verify the new entry by running a simple test query through `query_database` (e.g. `SELECT 1`). If it fails:

When the daemon refuses to load an entry, the loader emits a single warning line per affected database to the daemon log. Common shapes:

- `[Config] Skipping database "<name>": missing required field "<field>" for type "<type>"` — the schema rejected the entry. Cross-reference the per-adapter table above; add the missing field or correct its placement.
- `[Config] Skipping database "<name>": field "type" must be a string (got <typeof>)` — the `type` value is the wrong shape (e.g. `type = 42`).
- `[Config] Skipping database "<name>": unknown type "<type>". Valid types: postgres, mysql, ...` — typo in the `type` value.
- `[Config] Skipping database "<name>": snowflake requires either "password" (basic auth) or "credentials_file" (key-pair auth)` — pick one auth method per the snowflake section above.
- `[Config] Unknown field "<key>" on databases.<name> — ignored. Did you mean "<suggestion>"?` — a typo in a field name. The entry still loads with the field unset; fix the typo if the value mattered.

When the entry loads but the test query fails, the error comes from the driver, not the loader. Common causes:

- `password authentication failed` (postgres/mysql/mssql/clickhouse): wrong `password`, wrong `user`, or the user lacks `CONNECT` / `USAGE` privileges on the target database.
- `database "<name>" does not exist` (postgres) / `Unknown database` (mysql): the `database` value doesn't match a real database on the server.
- Connection timeouts: wrong `host`/`port`, server not running, firewall, or (for remote servers) the user's machine isn't on the right network. Verify with the native client first (`psql`, `mysql`, etc.) before assuming the issue is in the config.
- Snowflake `Authentication failed`: for basic auth, double-check `account` (no `https://` prefix, no `.snowflakecomputing.com` suffix). For key-pair, verify `credentials_file` is a PEM-formatted private key and matches the public key uploaded to the snowflake user.
- BigQuery `Could not load the default credentials`: ADC isn't configured. Either set `credentials_file` or run `gcloud auth application-default login`.

Fix the underlying issue, restart the daemon, and re-run the test query. Don't paper over real auth problems by removing fields — that just produces a different error.

## Other sections — short reference

These sections are user tunables with code-pinned defaults. Most users leave them commented; uncomment and edit only specific values you want to override. Defaults track the code, so a future System2 release that bumps a default propagates automatically as long as the line is commented.

### `[agents.<role>]` — per-agent behavior overrides

Roles: `guide`, `conductor`, `reviewer`, `narrator`, `worker`.

```toml
[agents.conductor]
thinking_level = "high"      # off | minimal | low | medium | high | xhigh
compaction_depth = 8         # number of auto-compactions to keep in sliding window
```

Per-role model pins live in `~/.system2/auth/.auth.toml` under `[llm.api_keys.<provider>.models]`, not here.

### `[backup]`, `[logs]`, `[scheduler]`, `[chat]`, `[knowledge]`, `[session]`, `[delivery]`, `web_search_max_results`

Operational tunables. The default template emits each as a commented section; uncomment the section header and the specific keys you want to change. See the inline comments in the template for descriptions of each field.

```toml
# [backup]
# cooldown_hours = 24
# max_backups = 3

# [scheduler]
# daily_summary_interval_minutes = 30

# Top-level scalar (no section)
# web_search_max_results = 5
```
