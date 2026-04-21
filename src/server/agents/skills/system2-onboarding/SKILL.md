---
name: system2-onboarding
description: Run on first launch (when ~/.system2/knowledge/infrastructure.md is still the template) or whenever the user explicitly asks to re-onboard. Greets the user, learns about them, detects the system, installs and configures the data stack (database, orchestrator, Python environments), scaffolds the pipeline repository, and captures interaction preferences.
roles: [guide]
---

# System2 Onboarding Mission

This skill defines the one-time setup the Guide runs on first launch. The goal is to leave the user with:

- A populated `~/.system2/knowledge/user.md` describing who they are and what they want.
- A populated `~/.system2/knowledge/infrastructure.md` describing their machine, data stack, and code repository.
- A populated `~/.system2/knowledge/guide.md` capturing any interaction preferences the user expressed.
- A working analytics database with schemas, users, and permissions initialized (PostgreSQL + TimescaleDB by default, but adapts to whatever the user already has or needs).
- A shared Python environment at `~/.system2/venv/` with notebooks, data libraries, and visualization tools, registered as a Jupyter kernel.
- An orchestrator installed and configured (Prefect by default, Airflow via Astronomer as alternative, or whatever the user already runs).
- A pipeline repository (cloned from openetl_scaffold or existing repo identified) with database tables created, credentials in `.env` and `~/.pgpass`, a repo-local `.venv/`, and the example pipeline verified end-to-end.
- Database connections registered in `~/.system2/config.toml` with Node.js drivers installed.
- The user oriented on `config.toml` so they know where to tune System2 later.

If the session is interrupted partway through, the next Guide session should re-invoke this skill, inspect what is already populated in those files, and resume from where it left off rather than starting over.

## Preamble

The knowledge files in `~/.system2/knowledge/` are seeded with structural templates. **Always read the entire file before editing it** so you see what is already populated and do not overwrite existing content. Preserve the template's section headings and structure. Lines starting with `>` are section descriptions explaining what belongs there: keep them as-is and write the actual content below them. Add new sections beyond the templated ones whenever the user's setup warrants it (e.g. a `## Streaming` section under Infrastructure, a `## Constraints` section under User Profile). Likewise, the JSON blocks in `infrastructure.md` are starting points: add fields as needed to accurately describe the user's infrastructure (e.g. `tunnel`, `read_replica`, `tls`, `package_manager`). The schemas are illustrative, not rigid.

**Handling credentials.** Many users will already have credentials configured in standard locations (e.g. `~/.pgpass` already exists, AWS is already set up via `aws configure`, GitHub via `gh auth login`). In those cases, simply point the `credentials` field in `infrastructure.md` at the existing file and move on. If the user instead shares a secret directly during the conversation, never write it to `infrastructure.md` or any other file under `~/.system2/knowledge/` (those files are git-tracked). Write the secret to the system's native credential location (creating the file with `chmod 600` if it does not already exist), then record the *path* to that location in the JSON block under a `credentials` field. Use the canonical native location for each system:

| System | Native location |
|--------|----------------|
| Postgres | `~/.pgpass` (format: `host:port:database:user:password`) |
| MySQL | `~/.my.cnf` |
| AWS | `~/.aws/credentials` (use `aws configure`) |
| GitHub CLI | `~/.config/gh/hosts.yml` (use `gh auth login`) |
| Generic HTTP | `~/.netrc` |
| REST API with no native location | project `.env` (must be gitignored) or `~/.config/<tool>/` |
| Anything else | OS keychain (`security` on macOS, `secret-tool` on Linux) |

## Steps

### 1. Greet the user

Introduce yourself and System2 warmly. You are genuinely excited about what data can reveal when approached with rigor and curiosity. Convey that in a couple of paragraphs:
- Who you are: the Guide, the user's primary point of contact for everything in System2.
- What System2 is: a team of AI agents that handles the full data lifecycle, from procurement to analysis to reporting. Briefly describe the roles: the Guide (you, system-wide, conversational interface), the Narrator (system-wide, maintains memory and writes project stories), and the per-project pair of Conductor (plans and executes) and Reviewer (validates work).
- What makes this different: the user gets a dedicated intelligence partner that learns their domain, remembers context across projects, and does the heavy lifting so they can focus on the questions that matter.
- Orient the user in the UI: the chat panel on the right is where you'll talk; the center area is the artifact viewer where reports, dashboards, and the Kanban board appear; the left sidebar lets them browse artifacts and see active agents. Point out the Board icon in the activity bar for tracking project progress. Let the user know they can ask you to show any file (e.g. "show me this report") and you'll display it in the artifact viewer if its format is supported.

Keep it conversational, not corporate. End by inviting the user to tell you about themselves.

### 2. Get to know the user

Ask about their background, what kind of work they do, what they hope to accomplish with System2. Follow the user's lead: some people want to share their full story, others just want to get started. Either is fine. Listen for: technical level (data engineer, analyst, researcher, business user), domain expertise, goals, and communication preferences. Save what you learn to `~/.system2/knowledge/user.md`, following the instructions for editing knowledge files in the Preamble. Do not front-load a list of questions; have a conversation.

### 3. Detect system information

Tell the user you're going to take a quick look at their system, then run:
- Detect OS: `node -e "console.log(process.platform)"` (returns `win32`, `darwin`, or `linux`)
- Check resources: CPU, RAM, disk space, network
- Check installed tools: `git --version`, `python3 --version`, `pip3 --version`, `docker --version`, `psql --version`
- Detect the platform package manager (macOS: `brew`, Linux: `apt`/`dnf`/distro equivalent, Windows: `winget` or `choco`)
- Share a brief summary of what you found with the user
- Save findings to `~/.system2/knowledge/infrastructure.md`, following the instructions for editing knowledge files in the Preamble.

### 4. Inventory existing infrastructure

Before installing anything, understand what the user already has running.
- Ask whether the user has remote machines (VPS, home server, cloud instances) where infrastructure runs or could run. If so, understand how to access them (SSH, Tailscale, etc.).
- Inventory existing databases, orchestration tools, and visualization tools (asking the user and checking the system). For each, ask and understand where it is deployed (local, remote), how to connect, and what access level System2 can have.
- Check for running services: `psql --version`, `prefect version`, `airflow version`, `docker ps`. Note what is already operational. If Airflow is already running locally, this affects the orchestrator recommendation in step 7.
- Save findings to `~/.system2/knowledge/infrastructure.md`, following the instructions for editing knowledge files in the Preamble.

### 5. GitHub and gh CLI

Run `gh auth status` and `git config user.email` to detect existing GitHub authentication.

- If already authenticated: confirm the GitHub username. Install `gh` if missing (`brew install gh` / `sudo apt install gh` / `winget install GitHub.cli`).
- If not authenticated or no account detected:
  - Explain what a GitHub account enables: pushing pipeline code to a remote, collaborating on open-source projects, cloning via SSH (no token expiry), forking repositories to maintain a customized version.
  - Ask whether the user has a GitHub account.
  - If yes: install `gh` via the platform package manager if absent, then run `gh auth login` interactively to authenticate. Confirm the username after login.
  - If no: ask if they would like help creating one. If yes, direct them to github.com to sign up, then return and run `gh auth login`. If they prefer to skip GitHub entirely, note that HTTPS cloning works without an account but pushing to remotes will not be available until they authenticate later.
- Save GitHub username (or "none") and preferred clone method (SSH / HTTPS) to `~/.system2/knowledge/infrastructure.md`.

### 6. Shared Python environment

- Install Python 3 and pip if not already present. Use the platform package manager.
- Create a shared System2 virtual environment at `~/.system2/venv/` using `python3 -m venv`. This holds notebook tooling, visualization libraries, and core data libraries shared across all projects. Pipeline-specific dependencies (including the orchestrator) live in a separate repo-local `.venv/` created during data stack setup in step 7.
- Activate the shared env and install:
  - Notebooks: `jupyterlab`, `ipykernel`, `ipywidgets` (the last is needed for interactive Plotly figures)
  - Data: `pandas`, `numpy`, `pyarrow`
  - Database: `sqlalchemy`, `psycopg[binary]`
  - HTTP and config: `httpx`, `python-dotenv`
  - Visualization: `plotly`, `dash[jupyter]` (the `[jupyter]` extra enables running Dash apps inline in JupyterLab)
- Register the shared env as a Jupyter kernel: `python -m ipykernel install --user --name system2 --display-name "System2"`

### 7. Data stack

This is the core of onboarding: getting the user from zero to a working local analytics environment. The goal is three things working together: an analytical database for storing and querying data, a pipeline repository for organizing extraction and transformation logic, and an orchestrator for scheduling and monitoring pipeline runs.

**Presenting the recommended stack.** If the inventory from step 4 shows the user has no existing data stack (or only fragments), present the recommended local setup as a cohesive package. Frame it as a starting point that grows with them, not a permanent commitment:

- **PostgreSQL with TimescaleDB**: a production-grade relational database with built-in time-series capabilities. It works equally well as a general-purpose analytics store and handles the kind of time-stamped data most pipelines produce. Runs locally with minimal resource overhead.
- **openetl_scaffold**: a starter repository with shared ETL utilities, orchestrator adapters for both Prefect and Airflow, database initialization scripts, and an example pipeline that verifies the full stack end-to-end. System2 clones it as `~/repos/system2_data_pipelines` (or a user-specified path) and detaches it from the upstream so it becomes the user's own repository to extend.
- **Prefect**: a lightweight, Python-native orchestrator that runs without containers. Flows are plain Python functions with decorators; the server and UI are a single `prefect server start` command. Good for local development and scales to production via Prefect Cloud.

Ask whether the user would like System2 to set this up. If they prefer **Airflow** over Prefect, that works (the scaffold has Airflow adapters ready), but note that local Airflow runs via Docker through the Astro CLI and is heavier to operate. If local Airflow was already detected running in step 4, suggest using it instead of adding Prefect. If the user wants a **different orchestrator** entirely (Dagster, Luigi, cron, etc.), respect their choice: install it via pip into the pipeline repo `.venv/` and skip the Prefect/Airflow-specific setup below.

If the user already has a working data stack from step 4, skip or modify the steps below to adapt to what is already in place and integrate System2 with what they have. If the user does not want the recommended stack at all, adapt to their wishes, but guide them toward having at least these three: one analytical database System2 can query, one way to run pipelines (even cron or manual runs as a starting point), and a git repository for pipeline code (does not require a GitHub remote).

#### 7a. Analytical database

First check what is already present:
```bash
psql --version                                   # is PostgreSQL installed?
psql -U postgres -c "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';"
```

- **PostgreSQL already fully configured with TimescaleDB**: confirm the connection works (`psql -U postgres -c "SELECT 1;"`) and move on. Do not re-run setup steps.
- **PostgreSQL installed but TimescaleDB missing**, or **fresh install needed**: fetch the [TimescaleDB self-hosted install page](https://docs.timescale.com/self-hosted/latest/install/) using `web_fetch`, find the section for the user's OS (detected in step 3), and follow the instructions. The page covers macOS (Homebrew), Debian/Ubuntu, RHEL/Fedora, and Windows. Key steps across all platforms: install PostgreSQL, install the TimescaleDB extension package, run `timescaledb-tune`, restart PostgreSQL, and verify with `CREATE EXTENSION IF NOT EXISTS timescaledb`.

  **Warning from the docs**: if PostgreSQL was previously installed via a different method than what the TimescaleDB instructions use (e.g. not Homebrew on macOS, or a manual install on Linux), you may encounter errors. The docs recommend either fully removing the existing PostgreSQL first, or installing TimescaleDB from source to preserve the current setup. Check how PostgreSQL was installed and if it contains data before proceeding and adapt accordingly. Confirm with the user if they want to proceed with the installation of TimescaleDB given their existing PostgreSQL setup. Don't lose data!

**After install**: verify the connection works (`psql -U postgres -c "SELECT 1;"`) and note the version in `infrastructure.md`. Database creation, schema initialization, and IAM configuration happen in step 7c after the pipeline repository is cloned, using the scaffold's DDL scripts (`database.ddl`, `schemas.ddl`, `iam.sql`).

For each database discovered or installed, perform two additional actions:

**Install the database driver** into `~/.system2/node_modules/` so the server can connect at runtime. One command per database type in the stack:
```bash
npm install --prefix ~/.system2 pg                    # PostgreSQL, TimescaleDB, CockroachDB
npm install --prefix ~/.system2 mysql2                 # MySQL, MariaDB
npm install --prefix ~/.system2 mssql                  # SQL Server, Azure SQL
npm install --prefix ~/.system2 @clickhouse/client     # ClickHouse
npm install --prefix ~/.system2 duckdb                 # DuckDB, MotherDuck
npm install --prefix ~/.system2 snowflake-sdk          # Snowflake
npm install --prefix ~/.system2 @google-cloud/bigquery # BigQuery
# SQLite: no install needed (built-in)
```

**Write a config entry** to `~/.system2/config.toml` for each database in the data stack (generally one). Use the `edit` tool with `append: true` to add a `[databases.<name>]` section. NEVER use the `write` tool on config.toml as it replaces the entire file and will destroy existing sections (LLM keys, services, operational settings). Passwords can be included directly in config.toml. Examples:

```toml
[databases.my_postgres]
type = "postgres"
host = "localhost"
port = 5432
database = "analytics"
user = "readonly"
password = "secret"

# Cloud services use account/project instead of host/port
[databases.my_snowflake]
type = "snowflake"
account = "xy12345.us-east-1"   # resolves to xy12345.us-east-1.snowflakecomputing.com
database = "ANALYTICS"
warehouse = "COMPUTE_WH"
user = "analyst"
role = "ANALYST"
# password via SNOWFLAKE_PASSWORD env var, or use credentials_file for key-pair auth

[databases.my_bigquery]
type = "bigquery"
project = "my-project-123"
database = "my_dataset"          # BigQuery dataset name
credentials_file = "/path/to/service-account.json"  # or use gcloud ADC
```

For SQLite and DuckDB, only `type` and `database` (the file path) are needed:

```toml
[databases.my_sqlite]
type = "sqlite"
database = "/path/to/data.db"

[databases.my_duckdb]
type = "duckdb"
database = "/path/to/analysis.duckdb"
```

After writing the config entries, verify each connection works by using the `bash` tool to run a simple test query (e.g. `SELECT 1`). If a connection fails, troubleshoot with the user before moving on.

#### 7b. Pipeline repository

Ask whether the user has an existing data pipeline repository:

- **If yes**: get the local path and remote URL (if applicable). Note the path in `infrastructure.md`. Read `README.md`, `CONTRIBUTING.md`, and `CLAUDE.md` (if present) and note the top-level structure. Skip the clone step.

- **If no**: clone and rename the scaffold:
  ```bash
  git clone https://github.com/diegoscarabelli/openetl_scaffold.git ~/repos/system2_data_pipelines
  cd ~/repos/system2_data_pipelines
  git remote remove origin
  ```
  Use a user-specified path instead of `~/repos/system2_data_pipelines` if requested. After cloning, read the repo's `README.md`, `CONTRIBUTING.md`, and `CLAUDE.md` to understand the project structure and conventions.

  If the user has a GitHub account (from step 5), offer to create a private remote:
  ```bash
  gh repo create system2_data_pipelines --private --source=. --remote=origin --push
  ```
  If no GitHub account, the repo works as a local git repo only. A remote can be added later.

#### 7c. Initialize the database

Use the scaffold's DDL scripts (run as superuser, e.g. `postgres`). Before running `iam.sql`, edit the passwords for `data_pipelines` and `read_only` users inside that file. Run once per target database (`lens` for production, `lens_dev` for development):
```bash
# Create the databases:
psql -U postgres -f database.ddl

# For each database (lens and lens_dev):
psql -U postgres -d lens -f schemas.ddl
psql -U postgres -d lens -f iam.sql
psql -U postgres -d lens -f dags/pipelines/example/tables.ddl

# Repeat for lens_dev:
psql -U postgres -d lens_dev -f schemas.ddl
psql -U postgres -d lens_dev -f iam.sql
psql -U postgres -d lens_dev -f dags/pipelines/example/tables.ddl
```
The `iam.sql` script creates a `readers` role, a `read_only` user, and the `data_pipelines` app user with `pg_read_all_data` + `pg_write_all_data` grants (PostgreSQL 14+ predefined roles for blanket read/write across all schemas).

After the scripts have run, revert the passwords in `iam.sql` back to the placeholder values so they are not committed to git.

#### 7d. Configure credentials

Three database users exist after setup. Store each password in the right place:

| User | Role | Password location |
|------|------|-------------------|
| `postgres` | superuser (admin, DDL) | `~/.pgpass` |
| `data_pipelines` | read/write (pipeline code) | scaffold `.env` |
| `read_only` | read-only (System2 queries) | `~/.system2/config.toml` |

- For **`data_pipelines`**: read `.env.template` to understand the required variables (database connection details for `lens` and `lens_dev`: host, port, name, user, password). Then copy it and fill in the values:
  ```bash
  cp .env.template .env
  ```
- For **`read_only`**: write the password into the `config.toml` `[databases.<name>]` entry created in step 7a.
- For **`postgres`**: add a `~/.pgpass` entry (`localhost:5432:*:postgres:<password>`, `chmod 600 ~/.pgpass`).

Document all three credential locations in `infrastructure.md` (the locations, never the passwords themselves).

#### 7e. Repository Python environment

This step creates a project-local `.venv/` with the dependencies from `requirements.txt` and `requirements_dev.txt`. The orchestrator lines in `requirements.txt` are commented out by default: uncomment the one matching the user's chosen orchestrator. Then run:

```bash
make venv
source .venv/bin/activate
```

Note: this `.venv/` is separate from the shared `~/.system2/venv/` created in step 6. The shared env is for analysis, holds notebooks and visualization tools; the repo `.venv/` holds data pipeline-specific dependencies (SQLAlchemy, orchestrator, etc.).

#### 7f. Orchestrator

Install and configure the orchestrator the user chose at the beginning of this step. The orchestrator python package is installed into the repo's `.venv/` via `requirements.txt`, not the shared `~/.system2/venv/`.

The scaffold ships with Prefect and Airflow support out of the box. If the user chose a different orchestrator (e.g., Dagster, Luigi, cron), install it into the repo's `.venv/`, adapt the pipeline code to work with it, and adjust the project structure as needed. Record the orchestrator choice and setup details in `infrastructure.md`.

**If Prefect (default):**

Start the server (persistent runs, UI, scheduling). See the [Prefect server docs](https://docs.prefect.io/v3/manage/self-host) for details:
```bash
prefect server start                                        # keep running in background
prefect config set PREFECT_API_URL=http://localhost:4200/api
prefect work-pool create default --type process
prefect worker start --pool default                         # keep running in background
```
UI at http://localhost:4200.

Deploying and running flows:
```bash
prefect deploy dags/pipelines/<name>/flow.py:flow --name <name>-dev --work-pool default
prefect deployment run '<flow-name>/<name>-dev'
```

Monitoring:
```bash
prefect flow-run ls                           # list recent runs with state
prefect flow-run inspect <flow-run-id>        # logs, task states, parameters
prefect deployment ls                         # list deployments and schedules
```

Prefect Cloud (managed, no local server): `prefect cloud login` (browser auth).

**If Airflow (only if the user chose Airflow over Prefect):**

Astronomer is the recommended way to run Airflow 3 locally: it handles all Docker setup. Requirements: Docker Desktop (macOS/Windows) or Docker Engine (Linux) running.

Install the Astro CLI:
```bash
# macOS:
brew install astro
# Linux:
curl -sSL install.astronomer.io | sudo bash -s
# Windows:
winget install -e --id Astronomer.Astro
```

Initialize Astro CLI inside the scaffold repo, then clean up the placeholder DAG:
```bash
astro dev init
rm dags/exampledag.py
```

Configure `.astro/config.yaml` to avoid port collisions with the local PostgreSQL on 5432:
```yaml
postgres:
    port: "5434"
webserver:
    port: "8081"
```

Create `docker-compose.override.yml` to pass database credentials and mount the data directory into the scheduler container. Use `host.docker.internal` (macOS/Windows) or `172.17.0.1` (Linux) for `SQL_DB_HOST` so containers can reach the host database:
```yaml
services:
  scheduler:
    environment:
      - SQL_DB_HOST=host.docker.internal
      - SQL_DB_PORT=${SQL_DB_PORT}
      - SQL_DB_NAME=${SQL_DB_NAME}
      - SQL_DB_USER=${SQL_DB_USER}
      - SQL_DB_PASSWORD=${SQL_DB_PASSWORD}
      - DATA_DIR=/usr/local/airflow/data
      - AIRFLOW__LOGGING__ENABLE_TASK_CONTEXT_LOGGER=False
    volumes:
      - ${DATA_DIR:-./data}:/usr/local/airflow/data

  dag-processor:
    environment:
      - DATA_DIR=/usr/local/airflow/data
      - AIRFLOW__LOGGING__ENABLE_TASK_CONTEXT_LOGGER=False
```
The `${VAR}` references are resolved from the `.env` file in the project root.

Start Astronomer:
```bash
astro dev start
```
UI at http://localhost:8081 (default credentials: admin/admin).

Managing Astro:
```bash
astro dev restart   # picks up Python code changes without rebuilding
astro dev stop      # stop all containers
```

Triggering and monitoring DAGs:
```bash
astro dev run dags unpause <dag_id>                          # required before first trigger
astro dev run dags trigger <dag_id>                          # trigger a DAG run
astro dev run tasks states-for-dag-run <dag_id> "<run_id>"   # check task states
```

#### 7g. Verify the example pipeline

Run the example pipeline to confirm the full stack works end-to-end. Inform the user beforehand. For Prefect: ensure the server is running (step 7f), then deploy and run the example flow. For Airflow: unpause and trigger the `example` DAG (`astro dev run dags unpause example && astro dev run dags trigger example`). Check that data lands in the `wid` schema of the `lens` database.

#### 7h. Save to infrastructure.md

Read once again the `infrastructure.md` and make sure that all data stack details are accurately recorded and their use explained: database type and version, database names,orchestrator choice, repository path, data pipelines environment path.

### 8. Agent instruction files

Check for AI agent instruction files that may contain coding conventions or preferences:
- Per-repo: `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.github/copilot-instructions.md`
- Global: `~/.claude/CLAUDE.md`, `~/.cursor/rules/`
- Save findings to `~/.system2/knowledge/infrastructure.md`

### 9. Capture interaction preferences

Throughout the conversation the user may have expressed preferences about how they like to interact: verbosity, level of detail, how much autonomy to take, when to ask vs. act, etc. Save any such preferences to `~/.system2/knowledge/guide.md` so they carry over to future sessions.

### 10. Walk through config.toml

Show the user their `~/.system2/config.toml` file (use `show_artifact`) and walk them through the sections so they know what they can adjust later. Present the sections in order, adapting depth to the user's technical level:

- **`[llm]` and `[llm.<provider>]`**: The providers and API keys configured during CLI onboarding. They can add or remove providers, add multiple labeled keys per provider for rotation, and change the primary/fallback order. Mention that System2 automatically fails over between keys and providers when errors occur.
- **`[agents.<role>]`**: Per-role overrides for any agent (guide, conductor, narrator, reviewer, worker). They can change the `thinking_level` (off/minimal/low/medium/high), `compaction_depth` (how many context compactions before pruning), and `models.<provider>` (which model to use on a specific provider). Only specified fields override the library defaults. This is how they can, for example, run the Guide on a more capable model or reduce thinking for a fast-turnaround role.
- **`[services.*]` and `[tools.*]`**: Service credentials (e.g. Brave Search) and tool settings (e.g. web search toggle). Mention these briefly.
- **`[databases.*]`**: The database connections just configured. Each entry uses the section name (e.g. `analytics` in `[databases.analytics]`) as the identifier throughout System2, including in HTML dashboard queries via the postMessage bridge. Remind them they can add more databases later by adding a `[databases.<name>]` section and installing the corresponding Node.js driver (`npm install --prefix ~/.system2 <package>`), or they can just ask you and you'll handle both steps.
- **Operational sections** (`[backup]`, `[session]`, `[logs]`, `[scheduler]`, `[chat]`, `[knowledge]`): Mention these exist with sensible defaults and rarely need adjustment. Point out `scheduler.daily_summary_interval_minutes` as the one users might want to tune (controls how often the Narrator writes summaries).

Keep this conversational, not a lecture. A couple of sentences per section is enough. The goal is awareness that config.toml is the single place to tune System2, not memorization of every field.

### 11. Wrap up

Summarize what was configured: the user's profile, detected infrastructure, data stack, and code repository. Then ask what they'd like to work on first. Be excited to start working with data!
