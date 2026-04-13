# Artifacts

Artifacts are files produced as published results of analytical work: EDA notebooks, dashboards, plots, PDFs, markdown reports, and similar deliverables meant for the user to read and see. They are the tangible outputs of projects.

Pipeline code, utility scripts, intermediate data files, and other working materials are **not** artifacts. The distinction is intent: artifacts are created for the user to consume, not for agents to execute. Working files used during exploration, prototyping, and debugging belong in the [Scratchpad](scratchpad.md), which is the companion working area where source notebooks, intermediate data dumps, and prototype scripts live before anything is published as an artifact.

**Key source files:**
- `packages/server/src/agents/tools/show-artifact.ts`: Guide-only tool to display artifacts in the UI
- `packages/server/src/agents/tools/write-system2-db.ts`: CRUD operations (`createArtifact`, `updateArtifact`, `deleteArtifact`)
- `packages/server/src/db/client.ts`: database methods (`createArtifact`, `getArtifact`, `getArtifactByPath`, `updateArtifact`, `deleteArtifact`)
- `packages/server/src/server.ts`: HTTP endpoints (`/api/artifact`, `/api/artifacts`, `/api/query`)
- `packages/server/src/websocket/handler.ts`: WebSocket artifact events and file watching
- `packages/ui/src/components/ArtifactViewer.tsx`: tabbed viewer with iframe/markdown rendering
- `packages/ui/src/components/ArtifactCatalog.tsx`: browsable catalog panel
- `packages/ui/src/stores/artifact.ts`: Zustand store for tab state (persisted to localStorage)

## What Qualifies as an Artifact

Examples of artifacts:
- Jupyter notebooks converted to HTML (for iframe rendering in the UI)
- Interactive HTML/JS dashboards
- Static plots and charts (PNG, SVG)
- PDF reports
- Markdown summaries and write-ups
- CSV/Excel data exports intended for the user

Not artifacts:
- Python scripts, pipeline code, SQL files (these are working tools, not deliverables)
- Intermediate data files (staging CSVs, temp parquet files): these belong in the [Scratchpad](scratchpad.md)
- Configuration files, logs, knowledge files

## File Storage

Artifact files can live anywhere on the filesystem. The `file_path` column in the database stores the absolute path.

**Conventional locations:**

| Location | When to use |
|----------|-------------|
| `~/.system2/projects/{id}_{name}/artifacts/` | Artifacts tied to a specific project |
| `~/.system2/artifacts/` | Artifacts not associated with any project |
| Elsewhere on the filesystem | When a more natural location exists (e.g., an analysis directory the user has designated) |

Custom artifact locations should be documented in `knowledge/infrastructure.md` (the technical environment) and `knowledge/user.md` (user preferences) so all agents can find them.

## Database Registration

Every artifact must have a record in the `artifact` table. The UI artifact catalog is driven entirely by these records: an artifact without a database record is invisible to the user.

**Schema** (see [Database](database.md#artifact) for full column definitions):

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-incrementing |
| `project` | INTEGER FK | References `project(id)`. NULL for project-free artifacts. |
| `file_path` | TEXT NOT NULL UNIQUE | Absolute path to the artifact file |
| `title` | TEXT NOT NULL | Display title (used as tab label in the UI) |
| `description` | TEXT | Optional summary |
| `tags` | TEXT | JSON array of strings for categorization/filtering |

**CRUD operations** are available through the `write_system2_db` tool:
- `createArtifact`: requires `file_path` and `title`; optional `project`, `description`, `tags`
- `updateArtifact`: update any metadata field by record `id`
- `deleteArtifact`: removes the database record only (not the file itself)

Project-scoped agents can only manage artifacts within their own project. Agents without a project (e.g., the Guide) can also access artifacts that have no project association.

## Displaying Artifacts

The `show_artifact` tool displays a file in the artifact viewer panel. It accepts an absolute file path (supports `~/` prefix), looks up the title from the database (falls back to filename if unregistered), and streams the file to the UI.

The tool technically accepts any file path, not just registered artifacts. This is an intentional escape hatch for one-off viewing, but the primary workflow is: create the file, register it as an artifact in the database, then show it. Unregistered files lack titles, descriptions, and tags, and will not appear in the artifact catalog.

**Rendering by file type:**

- `.html`, `.htm`: rendered in a sandboxed iframe (best experience for dashboards and interactive content)
- `.md`: rendered as styled markdown (via react-markdown)
- Images, PDFs: rendered natively by the browser in the iframe
- Plain text (`.txt`, `.csv`, `.py`, etc.): displayed as raw text in the iframe (readable but unstyled, no syntax highlighting)
- Multiple artifacts can be open simultaneously in tabs

**Live reload:** when `show_artifact` is called, the server starts an `fs.watch` on the file. Any modification triggers an automatic UI refresh of the corresponding tab (cache-busted URL). Only one artifact is watched at a time; showing a new artifact closes the previous watcher.

## Interactive Dashboards (postMessage Bridge)

HTML/JS artifacts rendered in iframes can query databases through a postMessage bridge. This enables interactive dashboards that display live data from the user's analytical infrastructure.

**Supported databases:** PostgreSQL (including TimescaleDB, CockroachDB, Redshift, AlloyDB, Neon, Supabase), MySQL (including MariaDB), SQLite, MSSQL/SQL Server, ClickHouse, DuckDB (including MotherDuck), Snowflake, and BigQuery. Connections are configured under `[databases.<name>]` in config.toml (see [Configuration](configuration.md#databases)). The built-in `system2` database (app.db) is always available.

**Protocol:**

1. The iframe sends a message to the parent window:
   ```js
   window.parent.postMessage({
     type: 'system2:query',
     requestId: 'unique-id',
     sql: 'SELECT ...',
     database: 'analytics'  // optional: defaults to 'system2' (app.db)
   }, '*');
   ```

2. The UI forwards the query to `POST /api/query`.

3. The result is posted back to the iframe:
   ```js
   // Success
   { type: 'system2:query_result', requestId: 'unique-id', data: { rows, count } }
   // Error
   { type: 'system2:query_error', requestId: 'unique-id', error: 'message' }
   ```

**Security:** Only SELECT queries are allowed. The server rejects DML/DDL keywords (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, etc.), multi-statement queries (semicolons within the body), and non-SELECT statements. Results are capped at `max_rows` (default 10,000) per query, and queries time out after `query_timeout` seconds (default 30). Unknown database names or unsupported types return HTTP 400.

**Architecture:** The server maintains a `DatabaseAdapterRegistry` that lazily creates database connections on first use. Each adapter dynamically loads its driver package from `~/.system2/node_modules/` (installed during onboarding). Connections are pooled where the driver supports it and torn down after 5 minutes of inactivity. The registry is initialized from `config.toml` at server startup. See `packages/server/src/db/adapter-registry.ts` and the individual adapters in `packages/server/src/db/adapters/`.

## HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/artifact?path=<encoded_path>` | Serve an artifact file from disk. Resolves `~/` paths. Returns `no-cache` headers. |
| GET | `/api/artifacts` | List all registered artifacts with project names, ordered by creation date (descending). |
| POST | `/api/query` | Execute a read-only SQL query (SELECT only). Used by the postMessage bridge for interactive dashboards. |

## WebSocket Events

When `show_artifact` completes successfully, the WebSocket handler emits an `artifact` message to the UI:

```json
{
  "type": "artifact",
  "url": "/api/artifact?path=%2Fhome%2Fuser%2Freports%2Fdashboard.html",
  "title": "EDA Dashboard",
  "filePath": "/home/user/reports/dashboard.html"
}
```

The same message type is sent on live reload (with a cache-busting `&t=<timestamp>` appended to the URL).

## UI Components

**ArtifactViewer** (`packages/ui/src/components/ArtifactViewer.tsx`): the main display area. Renders a tab bar with title and close buttons. Each tab is either an iframe (HTML/JS) or a native component (the Kanban board). Includes the postMessage bridge listener and a ResizeObserver for dynamic iframe content.

**ArtifactCatalog** (`packages/ui/src/components/ArtifactCatalog.tsx`): a toggleable overlay panel listing all registered artifacts. Grouped by project, filterable by tags and project. Clicking an item opens it in a new tab. Polls `/api/artifacts` every 2 seconds.

**Artifact store** (`packages/ui/src/stores/artifact.ts`): Zustand store managing tab state (open tabs, active tab, panel visibility). Persisted to localStorage via the Zustand persist middleware. Deduplicates tabs by `filePath`: opening an already-open artifact activates its existing tab.

## See Also

- [Scratchpad](scratchpad.md): the working area for exploration, prototyping, and intermediate data; source files and drafts that may eventually be promoted to artifacts
- [Database](database.md#artifact): full column definitions and indices
- [Tools](tools.md#show_artifact): `show_artifact` tool parameters and behavior
- [WebSocket Protocol](websocket-protocol.md): artifact message type and live reload events
- [Agents](agents.md): agent-facing artifact guidelines in the shared system prompt
- [UI Package](packages/ui.md): ArtifactViewer and ArtifactCatalog component details
