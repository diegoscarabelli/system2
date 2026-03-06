# Database

System2 uses [SQLite](https://www.sqlite.org/) via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) with WAL mode for concurrent read/write access.

**Key source files:**
- `packages/server/src/db/schema.sql` -- full schema
- `packages/server/src/db/client.ts` -- DatabaseClient class

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
| `role` | TEXT NOT NULL | `guide` \| `conductor` \| `narrator` \| `reviewer` |
| `project` | INTEGER FK | References `project(id)`. NULL for system-wide agents. |
| `status` | TEXT | `idle` \| `active` \| `archived` |
| `created_at` | TEXT | Auto-set |
| `updated_at` | TEXT | Auto-set |

**Indices:**
- `idx_agent_project` on `project`
- `idx_agent_role` on `role`
- `idx_agent_guide_singleton` -- unique on `role` WHERE `role = 'guide'` (enforces singleton)
- `idx_agent_narrator_singleton` -- unique on `role` WHERE `role = 'narrator'` (enforces singleton)

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

## DatabaseClient (`client.ts`)

The `DatabaseClient` class initializes SQLite with WAL mode and a 5-second busy timeout, then applies the schema.

### Key Methods

| Method | Description |
|--------|-------------|
| `getOrCreateGuideAgent()` | Returns the singleton guide agent, creating it if needed |
| `getOrCreateNarratorAgent()` | Returns the singleton narrator agent, creating it if needed |
| `getAgent(id)` | Get agent by ID |
| `query(sql)` | Execute a custom SELECT query, returns rows as objects |
| `close()` | Close the database connection |

Project, task, comment, and link CRUD methods are also available.

## Query Access

Agents query the database via the `query_database` tool (SELECT only). Interactive artifact dashboards use the `/api/query` POST endpoint, which also restricts to SELECT queries. See [Tools](tools.md#query_database).

## See Also

- [Shared Types](packages/shared.md) -- TypeScript interfaces matching this schema
- [Tools](tools.md) -- `query_database` tool
- [Server](packages/server.md) -- `/api/query` endpoint
