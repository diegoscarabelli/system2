# Database

System2 uses [SQLite](https://www.sqlite.org/) via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) with WAL mode for concurrent read/write access.

**Key source files:**
- `src/server/db/schema.sql`: full schema
- `src/server/db/client.ts`: DatabaseClient class

**Location:** `~/.system2/app.db`

## Schema

### `project`

Data projects managed by agents.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-incrementing |
| `name` | TEXT NOT NULL | Project name |
| `description` | TEXT NOT NULL | Project description |
| `status` | TEXT | `todo` \| `in progress` \| `review` \| `done` \| `abandoned` |
| `labels` | TEXT | JSON array of strings |
| `start_at` | TEXT | ISO 8601 timestamp |
| `end_at` | TEXT | ISO 8601 timestamp |
| `created_at` | TEXT | Auto-set |
| `updated_at` | TEXT | Auto-set |

**Index:** `idx_project_status` on `status`

### `agent`

AI agent instances.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-incrementing |
| `role` | TEXT NOT NULL | `guide` \| `conductor` \| `narrator` \| `reviewer` \| `worker` |
| `project` | INTEGER FK | References `project(id)`. NULL for system-wide agents. |
| `status` | TEXT | `active` \| `archived` |
| `created_at` | TEXT | Auto-set |
| `updated_at` | TEXT | Auto-set |

**Indices:**
- `idx_agent_project` on `project`
- `idx_agent_role` on `role`
- `idx_agent_guide_singleton`: unique on `role` WHERE `role = 'guide'` (enforces singleton)
- `idx_agent_narrator_singleton`: unique on `role` WHERE `role = 'narrator'` (enforces singleton)

### `task`

Work units within projects.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-incrementing |
| `parent` | INTEGER FK | References `task(id)`. NULL for top-level tasks. |
| `project` | INTEGER FK | References `project(id)`. NULL for standalone tasks. |
| `title` | TEXT NOT NULL | Short title |
| `description` | TEXT NOT NULL | Detailed description |
| `status` | TEXT | `todo` \| `in progress` \| `review` \| `done` \| `abandoned` |
| `priority` | TEXT | `low` \| `medium` \| `high` |
| `assignee` | INTEGER FK | References `agent(id)` |
| `labels` | TEXT | JSON array of strings |
| `start_at` / `end_at` | TEXT | ISO 8601 timestamps |
| `created_at` / `updated_at` | TEXT | Auto-set |

**Indices:** `idx_task_parent`, `idx_task_project`, `idx_task_status`, `idx_task_assignee`

### `task_link`

Directed relationships between tasks.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-incrementing |
| `source` | INTEGER FK NOT NULL | The task that has the relationship |
| `target` | INTEGER FK NOT NULL | The task being referenced |
| `relationship` | TEXT NOT NULL | `blocked_by` \| `relates_to` \| `duplicates` |

**Indices:** `idx_task_link_unique` (unique on source + target + relationship), `idx_task_link_target`

### `task_comment`

Agent-authored comments on tasks.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-incrementing |
| `task` | INTEGER FK NOT NULL | References `task(id)` |
| `author` | INTEGER FK NOT NULL | References `agent(id)` |
| `content` | TEXT NOT NULL | Comment body |

### `artifact`

File artifacts created by agents, displayed in the UI. See [Artifacts](artifacts.md) for the full artifact system documentation.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-incrementing |
| `project` | INTEGER FK | References `project(id)`. NULL for project-independent artifacts. |
| `file_path` | TEXT NOT NULL UNIQUE | Absolute path to the artifact file |
| `title` | TEXT NOT NULL | Display title |
| `description` | TEXT | Optional description |
| `tags` | TEXT | JSON array of strings |
| `created_at` | TEXT | Auto-set |
| `updated_at` | TEXT | Auto-set |

**Indices:** `idx_artifact_project` on `project`, `idx_artifact_file_path` on `file_path`

### `job_execution`

Scheduler job execution records.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-incrementing |
| `job_name` | TEXT NOT NULL | Job identifier (e.g., `daily-summary`, `memory-update`) |
| `status` | TEXT NOT NULL | `running` \| `completed` \| `failed` \| `skipped` |
| `trigger_type` | TEXT NOT NULL | `cron` \| `catch-up` \| `manual` |
| `error` | TEXT | Error message (`failed`) or skip reason (`skipped`) |
| `started_at` | TEXT NOT NULL | ISO 8601 timestamp when execution began |
| `ended_at` | TEXT | ISO 8601 timestamp when execution finished |
| `created_at` / `updated_at` | TEXT | Auto-set |

**Indices:** `idx_job_execution_job_name` on `job_name`, `idx_job_execution_status` on `status`, `idx_job_execution_started_at` on `started_at`

## Timestamp Format

All `DEFAULT` expressions in the schema use `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` instead of `datetime('now')` to produce proper ISO 8601 timestamps with a `Z` (UTC) suffix. `UPDATE` statements in `DatabaseClient` follow the same convention, so every `created_at` and `updated_at` value stored in the database is a valid ISO 8601 string that JavaScript's `Date` constructor parses correctly without any suffix workaround.

## DatabaseClient (`client.ts`)

The `DatabaseClient` class initializes SQLite with WAL mode and a 5-second busy timeout, then applies the schema.

### Key Methods

| Method | Description |
|--------|-------------|
| `getOrCreateGuideAgent()` | Returns the singleton guide agent, creating it if needed |
| `getOrCreateNarratorAgent()` | Returns the singleton narrator agent, creating it if needed |
| `getAgent(id)` | Get agent by ID |
| `query(sql)` | Execute a custom SELECT query, returns rows as objects |
| `createJobExecution(jobName, triggerType)` | Insert a new execution with status `running` |
| `completeJobExecution(id)` | Mark execution as `completed` with `ended_at` |
| `failJobExecution(id, error)` | Mark execution as `failed` with error message |
| `failStaleJobExecutions(error)` | Bulk-fail all `running` rows (startup crash recovery) |
| `listJobExecutions(filters?)` | List executions with optional `jobName`, `status`, `limit` filters |
| `close()` | Close the database connection |

Project, task, comment, link, and artifact CRUD methods are also available (`createArtifact`, `getArtifact`, `updateArtifact`, `deleteArtifact`).

## Database Access for Agents

Both tools operate exclusively on `~/.system2/app.db`, the System2 management database. They are **not** for querying data pipeline databases (TimescaleDB, DuckDB, etc.); use `bash` for those.

### Read access

Agents query the database via the `read_system2_db` tool (SELECT only). Interactive artifact dashboards use the `/api/query` POST endpoint, which also restricts to SELECT queries. See [Tools](tools.md#read_system2_db).

### Write access

Agents write to the database via the `write_system2_db` tool, which exposes structured named operations (`createProject`, `updateProject`, `createTask`, `updateTask`, `createTaskLink`, `deleteTaskLink`, `createTaskComment`, `updateTaskComment`, `deleteTaskComment`, `createArtifact`, `updateArtifact`, `deleteArtifact`, `rawSql`). These delegate to `DatabaseClient` methods, ensuring `updated_at` is always maintained and `task_comment.author` is auto-filled from the calling agent's ID. `updateTaskComment` is restricted to the original author so attribution stays honest. The `rawSql` operation accepts DML and SELECT statements for cases not covered by named operations; DDL, PRAGMA, and maintenance statements are blocked. See [Tools](tools.md#write_system2_db).

Each write triggers an `onWrite` callback that the server maps to a WebSocket push notification (`board_changed`, `agents_changed`, `artifacts_changed`, etc.), so UI panels update in real time. Direct `sqlite3` access to `app.db` via `bash` is blocked to ensure all writes flow through this notification path. These restrictions apply exclusively to `app.db`; agents operate on data pipeline databases (TimescaleDB, DuckDB, etc.) directly via `bash` with no restrictions.

## See Also

- [Shared Types](shared.md): TypeScript interfaces matching this schema
- [Tools](tools.md): `read_system2_db` and `write_system2_db` tools
- [Server](server.md): `/api/query` endpoint
