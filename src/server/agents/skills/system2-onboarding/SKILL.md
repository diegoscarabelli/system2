---
name: system2-onboarding
description: Run on first launch (when ~/.system2/knowledge/infrastructure.md is still the template) or whenever the user explicitly asks to re-onboard. Greets the user, learns about them, detects the system, configures the data stack, sets up the development environment, and captures interaction preferences.
roles: [guide]
---

# System2 Onboarding Mission

This skill defines the one-time setup the Guide runs on first launch. The goal is to leave the user with:

- A populated `~/.system2/knowledge/user.md` describing who they are and what they want.
- A populated `~/.system2/knowledge/infrastructure.md` describing their machine, data stack, and code repository.
- A populated `~/.system2/knowledge/guide.md` capturing any interaction preferences the user expressed.
- A working shared Python environment under `~/.system2/venv/` registered as a Jupyter kernel.

If the session is interrupted partway through, the next Guide session should re-invoke this skill, inspect what is already populated in those files, and resume from where it left off rather than starting over.

## Steps

The knowledge files in `~/.system2/knowledge/` are seeded with structural templates. Feel free to add sections beyond the templated ones whenever the user's setup warrants it (e.g. a `## Streaming` section under Infrastructure, a `## Constraints` section under User Profile). Likewise, the JSON blocks in `infrastructure.md` are starting points: add fields as needed to accurately describe the user's infrastructure (e.g. `tunnel`, `read_replica`, `tls`, `package_manager`). The schemas are illustrative, not rigid.

**Handling credentials.** Many users will already have credentials configured in standard locations (e.g. `~/.pgpass` already exists, AWS is already set up via `aws configure`, GitHub via `gh auth login`). In those cases, simply point the `credentials` field in `infrastructure.md` at the existing file and move on: do not create, modify, or read the file. If the user instead shares a secret directly during the conversation, never write it to `infrastructure.md` or any other file under `~/.system2/knowledge/` (those files are git-tracked). Write the secret to the system's native credential location (creating the file with `chmod 600` if it does not already exist), then record the *path* to that location in the JSON block under a `credentials` field. Use the canonical native location for each system:

| System | Native location |
|--------|----------------|
| Postgres | `~/.pgpass` (format: `host:port:database:user:password`) |
| MySQL | `~/.my.cnf` |
| AWS | `~/.aws/credentials` (use `aws configure`) |
| GitHub CLI | `~/.config/gh/hosts.yml` (use `gh auth login`) |
| Generic HTTP | `~/.netrc` |
| REST API with no native location | project `.env` (must be gitignored) or `~/.config/<tool>/` |
| Anything else | OS keychain (`security` on macOS, `secret-tool` on Linux) |

1. **Greet the user:**
   Introduce yourself and System2 warmly. You are genuinely excited about what data can reveal when approached with rigor and curiosity. Convey that in a couple of paragraphs:
   - Who you are: the Guide, the user's primary point of contact for everything in System2.
   - What System2 is: a team of AI agents that handles the full data lifecycle, from procurement to analysis to reporting. Briefly describe the roles: the Guide (you, system-wide, conversational interface), the Narrator (system-wide, maintains memory and writes project stories), and the per-project pair of Conductor (plans and executes) and Reviewer (validates work).
   - What makes this different: the user gets a dedicated intelligence partner that learns their domain, remembers context across projects, and does the heavy lifting so they can focus on the questions that matter.
   - Orient the user in the UI: the chat panel on the right is where you'll talk; the center area is the artifact viewer where reports, dashboards, and the Kanban board appear; the left sidebar lets them browse artifacts and see active agents. Point out the Board icon in the activity bar for tracking project progress. Let the user know they can ask you to show any file (e.g. "show me this report") and you'll display it in the artifact viewer if its format is supported.

   Keep it conversational, not corporate. End by inviting the user to tell you about themselves.

2. **Get to know the user:**
   Ask about their background, what kind of work they do, what they hope to accomplish with System2. Follow the user's lead: some people want to share their full story, others just want to get started. Either is fine. Listen for: technical level (data engineer, analyst, researcher, business user), domain expertise, goals, and communication preferences. Save what you learn to `~/.system2/knowledge/user.md`. Do not front-load a list of questions; have a conversation.

3. **Detect system information:**
   Tell the user you're going to take a quick look at their system, then run:
   - Detect OS: `node -e "console.log(process.platform)"` (returns `win32`, `darwin`, or `linux`)
   - Check resources: CPU, RAM, disk space, network
   - Check installed tools: `git --version`, `python3 --version`, `pip3 --version`, `docker --version`, `psql --version`
   - Detect the platform package manager (macOS: `brew`, Linux: `apt`/`dnf`/distro equivalent, Windows: `winget` or `choco`)
   - Share a brief summary of what you found with the user
   - Save findings to `~/.system2/knowledge/infrastructure.md` (template already exists)

4. **Configure data stack collaboratively:**
   - Adapt explanations to user's skill level
   - Ask whether the user has remote machines (VPS, home server, cloud instances) where infrastructure runs or could run. If so, understand how to access them (SSH, Tailscale, etc.).
   - Inventory what already exists: databases, orchestration tools, visualization tools. For each, understand where it is deployed (local, remote), how to connect, and what access level System2 can have.
   - If the user has no data stack, propose and install a minimal one locally. Walk through each component below, skipping or adapting based on what is already installed.

   **4a. PostgreSQL + TimescaleDB**

   First check what is already present:
   ```bash
   psql --version                                   # is PostgreSQL installed?
   psql -U postgres -c "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';"
   ```

   **macOS (Homebrew)** — fresh install:
   ```bash
   brew install postgresql@17
   brew services start postgresql@17

   # TimescaleDB lives in a third-party tap:
   brew tap timescale/tap
   brew install timescaledb           # extension (compiled against postgresql@17)
   brew install timescaledb-tools     # provides timescaledb-tune

   # Move the extension files into PostgreSQL's extension/lib directories:
   timescaledb_move.sh

   # Auto-configure shared_preload_libraries and tuned memory settings:
   timescaledb-tune --quiet --yes
   brew services restart postgresql@17

   # Verify:
   psql postgres -c "SELECT version();"
   psql postgres -c "CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT extversion FROM pg_extension WHERE extname='timescaledb';"
   ```

   **Linux (Ubuntu/Debian)** — fresh install:
   ```bash
   sudo apt install -y gnupg postgresql-common apt-transport-https lsb-release wget
   sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
   sudo apt install -y timescaledb-2-postgresql-17
   sudo timescaledb-tune --quiet --yes
   sudo systemctl restart postgresql
   # Verify:
   sudo -u postgres psql -c "SELECT version();"
   ```

   **Linux (RHEL/Fedora)**:
   ```bash
   sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm
   sudo dnf install -y postgresql17-server timescaledb_17
   sudo /usr/pgsql-17/bin/postgresql-17-setup initdb
   sudo timescaledb-tune --quiet --yes
   sudo systemctl enable --now postgresql-17
   ```

   **PostgreSQL already installed but TimescaleDB missing**:
   - macOS: `brew tap timescale/tap && brew install timescaledb timescaledb-tools && timescaledb_move.sh && timescaledb-tune --quiet --yes && brew services restart postgresql@17`
   - Linux: install `timescaledb-2-postgresql-$(pg_config --version | awk '{print $2}' | cut -d. -f1)` and restart

   **PostgreSQL already fully configured**: confirm the connection works (`psql -U postgres -c "SELECT 1;"`) and move on. Do not re-run setup steps.

   **After install**: verify the connection works (`psql -U postgres -c "SELECT 1;"`) and note the version in `infrastructure.md`. Database creation, schema initialization, and IAM configuration happen in step 5b after the pipeline repository is cloned, using the scaffold's DDL scripts (`database.ddl`, `schemas.ddl`, `iam.sql`).

   **4b. Python environment**

   - Python 3 and pip if not already installed. Install via the platform package manager.
   - Create a shared System2 virtual environment at `~/.system2/venv/` using `python3 -m venv`. This holds notebook tooling, visualization libraries, and core data libraries. The orchestrator is added in step 4c. Pipeline-specific dependencies live in a separate repo-local `.venv/` created in step 5b.
   - Activate the shared env and install:
     - Notebooks: `jupyterlab`, `ipykernel`, `ipywidgets` (the last is needed for interactive Plotly figures)
     - Data: `pandas`, `numpy`, `pyarrow`
     - Database: `sqlalchemy`, `psycopg[binary]`
     - HTTP and config: `httpx`, `python-dotenv`
     - Visualization: `plotly`, `dash[jupyter]` (the `[jupyter]` extra enables running Dash apps inline in JupyterLab)
   - Register the shared env as a Jupyter kernel: `python -m ipykernel install --user --name system2 --display-name "System2"`

   **4c. Orchestrator**

   Ask which orchestrator the user wants. Default to Prefect. Airflow (via Astronomer) is the alternative. Other tools (Dagster, Luigi, etc.) are supported but not detailed here — install via pip and configure manually.

   **Prefect (default)**:

   Install into the shared venv:
   ```bash
   pip install prefect
   ```

   If Prefect is already installed, run `prefect version` and check whether a server or Cloud profile is configured (`prefect config view`). If already fully set up, skip installation.

   Prefect server/worker setup and flow deployment happen in step 5b after the pipeline repository is cloned.

   **Airflow 3 via Astronomer (if user prefers Airflow)**:

   Astronomer is the recommended way to run Airflow 3 locally: it handles all Docker setup.

   Requirements: Docker Desktop running.

   Install the Astro CLI:
   ```bash
   # macOS:
   brew install astro
   # Linux:
   curl -sSL install.astronomer.io | sudo bash -s
   # Windows:
   winget install -e --id Astronomer.Astro
   ```

   If Airflow is already installed (not via Astronomer): run `airflow version` and note it. Astro project initialization and startup happen in step 5b after the pipeline repository is cloned (the scaffold already ships the required Astro configuration files).
   - Save all findings and configurations to `~/.system2/knowledge/infrastructure.md`
   - For each database discovered or installed, perform two additional actions:

     **Install the database driver** into `~/.system2/node_modules/` so the server can connect at runtime:
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

     **Write a config entry** to `~/.system2/config.toml` for each database. Use the `edit` tool with `append: true` to add a `[databases.<name>]` section. NEVER use the `write` tool on config.toml as it replaces the entire file and will destroy existing sections (LLM keys, services, operational settings). Do NOT include passwords: they belong in native credential files or environment variables. Examples:

     ```toml
     [databases.my_postgres]
     type = "postgres"
     host = "localhost"
     port = 5432
     database = "analytics"
     user = "readonly"

     [databases.my_snowflake]
     type = "snowflake"
     account = "xy12345.us-east-1"
     database = "ANALYTICS"
     warehouse = "COMPUTE_WH"
     user = "analyst"
     role = "ANALYST"

     [databases.my_bigquery]
     type = "bigquery"
     project = "my-project-123"
     database = "my_dataset"
     credentials_file = "/path/to/service-account.json"
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

     Common database-to-driver mappings:

     | Database | `type` value | Driver package |
     |----------|-------------|----------------|
     | PostgreSQL, TimescaleDB, CockroachDB | `postgres` | `pg` |
     | MySQL, MariaDB | `mysql` | `mysql2` |
     | SQLite | `sqlite` | (built-in) |
     | SQL Server, Azure SQL | `mssql` | `mssql` |
     | ClickHouse | `clickhouse` | `@clickhouse/client` |
     | DuckDB, MotherDuck | `duckdb` | `duckdb` |
     | Snowflake | `snowflake` | `snowflake-sdk` |
     | Google BigQuery | `bigquery` | `@google-cloud/bigquery` |

     After writing the config entries, verify each connection works by using the `bash` tool to run a simple test query (e.g. `SELECT 1`). If a connection fails, troubleshoot with the user before moving on.

5. **Configure development environment:**

   **5a. GitHub account and gh CLI**

   Run `gh auth status` and `git config user.email` to detect existing GitHub authentication.

   - If already authenticated: confirm the GitHub username. Install `gh` if missing (`brew install gh` / `sudo apt install gh` / `winget install GitHub.cli`).
   - If not authenticated or no account detected:
     - Explain what a GitHub account enables: pushing pipeline code to a remote, collaborating on open-source projects, cloning via SSH (no token expiry), forking repositories to maintain a customized version.
     - Ask whether the user has a GitHub account.
     - If yes: install `gh` via the platform package manager if absent, then run `gh auth login` interactively to authenticate. Confirm the username after login.
     - If no: ask if they would like help creating one. If yes, direct them to github.com to sign up, then return and run `gh auth login`. If they prefer to skip GitHub entirely, note that HTTPS cloning works without an account but pushing to remotes will not be available until they authenticate later.
   - Save GitHub username (or "none") and preferred clone method (SSH / HTTPS) to `~/.system2/knowledge/infrastructure.md`.

   **5b. Pipeline repository**

   Ask whether the user has an existing data pipeline repository:

   - **If yes**: get the local path and remote URL (if applicable). Read `README.md` and `CONTRIBUTING.md` (if present) and note the top-level structure. Note the path in `infrastructure.md`. If `dags/lib/` and `dags/pipelines/` are already present, the scaffold is not needed: skip the clone step.

   - **If no**: ask if they want to create a `system2_data_pipelines` repository with a starter scaffold. If yes, follow the sequence below. Use a user-specified path instead of `~/repos/system2_data_pipelines` if requested.

     **1. Clone and detach:**
     ```bash
     git clone https://github.com/diegoscarabelli/openetl_scaffold.git ~/repos/system2_data_pipelines
     cd ~/repos/system2_data_pipelines
     git remote remove origin
     ```

     **2. Initialize the database** using the scaffold's DDL scripts (run as superuser, e.g. `postgres`). Before running `iam.sql`, edit the passwords for `data_pipelines` and `read_only` users inside that file. Run once per target database (`lens` for production, `lens_dev` for development):
     ```bash
     # Create the databases:
     psql -U postgres -f database.ddl

     # For each database (lens and lens_dev):
     psql -U postgres -d lens -f schemas.ddl
     psql -U postgres -d lens -f iam.sql

     # Per-pipeline table DDL (example pipeline):
     psql -U postgres -d lens -f dags/pipelines/example/tables.ddl

     # Repeat for lens_dev:
     psql -U postgres -d lens_dev -f schemas.ddl
     psql -U postgres -d lens_dev -f iam.sql
     psql -U postgres -d lens_dev -f dags/pipelines/example/tables.ddl
     ```
     The `iam.sql` script creates a `readers` role, a `read_only` user, and the `data_pipelines` app user with `pg_read_all_data` + `pg_write_all_data` grants (PostgreSQL 14+ predefined roles for blanket read/write across all schemas).

     **3. Configure credentials:**
     ```bash
     cp .env.template .env
     ```
     Fill in the `.env` file. The scaffold uses the `SQL_DB_*` prefix (not `DB_*`) to avoid conflicts with Airflow's entrypoint health-check script which reserves `DB_HOST`:
     ```
     SQL_DB_HOST=localhost
     SQL_DB_PORT=5432
     SQL_DB_NAME=lens
     SQL_DB_USER=data_pipelines
     SQL_DB_PASSWORD=<password set in iam.sql>
     ```
     Store the `data_pipelines` password in `~/.pgpass` as well (format: `localhost:5432:*:data_pipelines:<password>`, `chmod 600 ~/.pgpass`). Record the `.env` path in `infrastructure.md`.

     **4. Python environment:**
     ```bash
     make venv
     source .venv/bin/activate
     ```
     This creates a project-local `.venv/` with the dependencies from `requirements.txt`. The orchestrator lines in `requirements.txt` are commented out by default: uncomment the one matching the user's chosen orchestrator, then re-run `make venv`.

     Note: this `.venv/` is separate from the shared `~/.system2/venv/` created in step 4b. The shared env holds notebooks and visualization tools; the repo `.venv/` holds pipeline-specific dependencies (SQLAlchemy, orchestrator, etc.).

     **5. Orchestrator setup:**

     **If Prefect:**

     Development mode (no server, good for initial testing):
     ```bash
     PYTHONPATH=dags python -m pipelines.example.flow
     ```
     The `PYTHONPATH=dags` is required so `from lib.xxx import yyy` resolves (Airflow/Astro auto-adds `dags/` to the path, but Prefect does not).

     Server mode (persistent runs, UI, recommended for ongoing use):
     ```bash
     prefect server start                                        # keep running in background
     prefect config set PREFECT_API_URL=http://localhost:4200/api
     prefect work-pool create default --type process
     prefect worker start --pool default                         # keep running in background
     ```
     UI at http://localhost:4200.

     Deploying and running flows:
     ```bash
     cd dags
     prefect deploy pipelines/<name>/flow.py:flow --name <name>-dev --work-pool default
     prefect deployment run '<flow-name>/<name>-dev'
     ```

     Monitoring:
     ```bash
     prefect flow-run ls                           # list recent runs with state
     prefect flow-run inspect <flow-run-id>        # logs, task states, parameters
     prefect deployment ls                         # list deployments and schedules
     ```

     Prefect Cloud (managed, no local server): `prefect cloud login` (browser auth).

     **If Airflow (Astronomer):**

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

     If a DAG run is in `running` state when Astronomer restarts, it becomes orphaned and may block new runs due to `max_active_runs`. Mark it as failed via the Airflow UI or API to unblock scheduling.

     **6. Verify the example pipeline:**
     Run the example pipeline to confirm the full stack works end-to-end. For Prefect: `PYTHONPATH=dags python -m pipelines.example.flow`. For Airflow: unpause and trigger the `example` DAG (`astro dev run dags unpause example && astro dev run dags trigger example`). Check that data lands in the `wid` schema of the `lens` database.

     **7. Optional GitHub remote:**
     If the user has a GitHub account (from step 5a), offer to create a private remote:
     ```bash
     gh repo create system2_data_pipelines --private --source=. --remote=origin --push
     ```
     If no GitHub account, the repo works as a local git repo only: a remote can be added later.

     **8.** Note the local path, orchestrator choice, and database names in `infrastructure.md`.

   - **If no to both**: note that the Conductor will create pipeline files in the working directory when the first pipeline project starts.

   **5c. Agent instruction files**

   Check for AI agent instruction files that may contain coding conventions or preferences:
   - Per-repo: `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.github/copilot-instructions.md`
   - Global: `~/.claude/CLAUDE.md`, `~/.cursor/rules/`
   - Save all findings and configurations to `~/.system2/knowledge/infrastructure.md`


6. **Capture interaction preferences:**
   Throughout the conversation the user may have expressed preferences about how they like to interact: verbosity, level of detail, how much autonomy to take, when to ask vs. act, etc. Save any such preferences to `~/.system2/knowledge/guide.md` so they carry over to future sessions.

7. **Walk through config.toml:**
   Show the user their `~/.system2/config.toml` file (use `show_artifact`) and walk them through the sections so they know what they can adjust later. Present the sections in order, adapting depth to the user's technical level:

   - **`[llm]` and `[llm.<provider>]`**: The providers and API keys configured during CLI onboarding. They can add or remove providers, add multiple labeled keys per provider for rotation, and change the primary/fallback order. Mention that System2 automatically fails over between keys and providers when errors occur.
   - **`[agents.<role>]`**: Per-role overrides for any agent (guide, conductor, narrator, reviewer, worker). They can change the `thinking_level` (off/minimal/low/medium/high), `compaction_depth` (how many context compactions before pruning), and `models.<provider>` (which model to use on a specific provider). Only specified fields override the library defaults. This is how they can, for example, run the Guide on a more capable model or reduce thinking for a fast-turnaround role.
   - **`[services.*]` and `[tools.*]`**: Service credentials (e.g. Brave Search) and tool settings (e.g. web search toggle). Mention these briefly.
   - **`[databases.*]`**: The database connections just configured. Each entry uses the section name (e.g. `analytics` in `[databases.analytics]`) as the identifier throughout System2, including in HTML dashboard queries via the postMessage bridge. Remind them they can add more databases later by adding a `[databases.<name>]` section and installing the corresponding Node.js driver (`npm install --prefix ~/.system2 <package>`), or they can just ask you and you'll handle both steps.
   - **Operational sections** (`[backup]`, `[session]`, `[logs]`, `[scheduler]`, `[chat]`, `[knowledge]`): Mention these exist with sensible defaults and rarely need adjustment. Point out `scheduler.daily_summary_interval_minutes` as the one users might want to tune (controls how often the Narrator writes summaries).

   Keep this conversational, not a lecture. A couple of sentences per section is enough. The goal is awareness that config.toml is the single place to tune System2, not memorization of every field.

8. **Wrap up:**
   Summarize what was configured: the user's profile, detected infrastructure, data stack, and code repository. Then ask what they'd like to work on first.
