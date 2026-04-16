---
name: pipeline-design
description: Conventions for building Python ETL/ELT pipelines: file state machine (ingest/process/store/quarantine), standard task sequence with customization hooks, config-first parametrization, per-pipeline directory layout, SQLAlchemy ORM integration (make_base, fkey, upsert). Framework-agnostic; applies to Airflow, Prefect, and others.
roles: [guide, conductor, reviewer, worker]
---

# Pipeline Design Conventions

These conventions apply to Python data pipelines regardless of orchestrator. For orchestrator-specific wiring, see the `airflow` or `prefect` skills.

The canonical scaffold implementing these conventions lives at
`https://github.com/diegoscarabelli/openetl_scaffold`. During onboarding the
Guide clones it to create the user's `system2_data_pipelines` repository.

## Repository Layout

```
dags/                          # Matches the DAGs folder Astro/Airflow hardcode.
  lib/                         # Shared utilities — one copy, used by every pipeline.
    pipeline_config.py         # PipelineConfig dataclass
    task_utils.py              # Standard task implementations (ingest/batch/process_wrapper/store)
    sql_utils.py               # SQLAlchemy helpers (make_base, fkey, upsert_model_instances)
    filesystem_utils.py        # File state machine (DataState, ETLDataDirectories, FileSet)
    processor.py               # Processor ABC
    airflow_utils.py           # Airflow 3 DAG factory (create_dag)
    prefect_utils.py           # Prefect flow factory (create_flow)
    logging_utils.py           # Simple logger
    __init__.py
  pipelines/
    {name}/                    # One subdirectory per pipeline.
      constants.py             # FileType enum with compiled regex patterns
      process.py               # Processor subclass (domain logic)
      sqla_models.py           # SQLAlchemy ORM models
      tables.ddl               # DDL for pipeline-specific tables
      dag.py                   # Airflow 3 entry point (~10 lines)
      flow.py                  # Prefect entry point (~10 lines)
      README.md
      __init__.py

data/                          # Runtime data dirs (gitignored); path set via DATA_DIR env var.
  {pipeline_id}/
    ingest/
    process/
    store/
    quarantine/

schemas.ddl                    # CREATE SCHEMA IF NOT EXISTS for all schemas.
database.ddl                   # CREATE DATABASE (run once, by hand).
requirements.txt
.env.example                   # DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DATA_DIR.
```

Everything lives under `dags/` because Astro CLI and native Airflow both hardcode `dags/` as the DAGs folder and auto-add it to PYTHONPATH, so `from lib.xxx import yyy` resolves without any config. Prefect is indifferent to the folder name — run flows locally with `PYTHONPATH=dags python -m pipelines.{name}.flow`.

Naming conventions: directory and module names are `lowercase_snake_case`; classes are `PascalCase`; pipeline IDs are `lowercase_snake_case` and match the directory name exactly.

**Database credentials**: stored in `.env` (gitignored), read at runtime via `python-dotenv`. Never hard-code credentials in Python files. The pipeline app user (`system2_pipelines`) has `SELECT/INSERT/UPDATE/DELETE` on data schemas only — no `CREATE TABLE` or admin privileges. DDL is run by hand (or by the Conductor) using the Postgres superuser.

## File State Machine

Every pipeline that processes files uses four directories under `{DATA_DIR}/{pipeline_id}/`:

| Directory | Purpose |
|-----------|---------|
| `ingest/` | Mailbox — raw files arrive here (manual drop or automated fetch) |
| `process/` | Staging — files move here while being actively processed |
| `store/` | Archive — successfully processed files land here permanently |
| `quarantine/` | Failure — files that caused errors are isolated here |

A `DataState` enum (`INGEST`, `PROCESS`, `STORE`, `QUARANTINE`) tracks state. Files are **never deleted** — they always move forward or sideways to quarantine. This makes pipelines auditable and replayable: recover a failed run by moving files back to `ingest/` and re-triggering.

`ETLDataDirectories` manages the four paths and creates them if missing. It is populated automatically from `pipeline_id` in `__post_init__`.

## Standard Task Sequence

Four predefined tasks form the default pipeline:

```
ingest → batch → process → store
```

**`ingest`**: scans `ingest/` for files matching configured regex patterns. Routes them to `process/` (files requiring transformation) or `store/` (pass-through files). Raises a skip signal if no matching files are found.

**`batch`**: groups files in `process/` into `FileSet` objects — one per logical processing unit (e.g., one export CSV, one day's sensor data). Returns serialized batches. Default groups by file timestamp; override via `config.batch_callable` (e.g., to group by `(user_id, date)`).

**`process`**: fans out over batches — one task instance per `FileSet` (dynamic task mapping). Each task instance instantiates `config.processor_class` with that single `FileSet` and calls `process()`. Returns `{"files": [...], "success": bool, "error": str|None}` — never raises, so all batches are attempted even if one fails.

**`store`**: collects the return values from all `process` task instances (via XCom in Airflow, task futures in Prefect) and routes files: `success=True` → `store/`, `success=False` → `quarantine/`.

The factory function (`create_dag` / `create_flow`) wires these four tasks and returns the orchestration object. A pipeline entry point is ~10 lines:

```python
# dags/pipelines/linkedin/dag.py (or flow.py for Prefect)
from lib.airflow_utils import create_dag        # or lib.prefect_utils for Prefect
from lib.pipeline_config import PipelineConfig
from .constants import LinkedInFileTypes
from .process import LinkedInProcessor

config = PipelineConfig(
    pipeline_id="linkedin",
    file_types=LinkedInFileTypes,
    processor_class=LinkedInProcessor,
    schedule=None,  # manual trigger
    ...
)
dag = create_dag(config)
```

### Customization hooks

Every stage is replaceable. Supply a callable via the config:

| Config field | Replaces |
|---|---|
| `config.ingest_callable` | Default ingest logic |
| `config.batch_callable` | Default grouping logic |
| `config.store_callable` | Default store/quarantine routing |
| `config.processor_class` | Required — the Processor subclass with domain logic |

## Config Dataclass

A single `PipelineConfig` dataclass is the single source of truth for a pipeline's behavior. `__post_init__` derives sensible defaults from `pipeline_id` (DB schema, DB user, data directories) so most pipelines only set a handful of fields:

```python
@dataclass
class PipelineConfig:
    pipeline_id: str                   # Matches directory name; used as DB schema + user prefix
    print_name: str                    # Human-readable label for logs and UI
    description: str
    file_types: type[Enum]             # Enum of compiled regex patterns
    processor_class: type[Processor]
    schedule: str | None               # Cron string, or None for manual-trigger-only
    start_date: datetime
    process_format: str                # Regex: files matching this go to process/
    store_format: str = ""             # Regex: files matching this go directly to store/
    max_process_tasks: int = 4         # Max concurrent process task instances
    min_file_sets_in_batch: int = 1
    # Derived in __post_init__:
    db_schema: str = ""                # → pipeline_id
    data_dirs: ETLDataDirectories = field(default_factory=ETLDataDirectories)
    # Callable overrides (all default to library implementations):
    ingest_callable: Callable | None = None
    batch_callable: Callable | None = None
    store_callable: Callable | None = None
```

## File Types and FileSet

**File types** are pipeline-specific `Enum` subclasses where each member is a compiled regex:

```python
import re
from enum import Enum

class LinkedInFileTypes(Enum):
    CONNECTIONS = re.compile(r"Connections.*\.csv$")
    INVITATIONS = re.compile(r"Invitations\.csv$")
```

**`FileSet`** coordinates a logical group of related files across file types within one batch:

```python
@dataclass
class FileSet:
    files: dict[str, list[Path]]        # key is the FileType enum member NAME (str)

    def get_files(self, file_type: Enum) -> list[Path]:
        return self.files.get(file_type.name, [])
```

The dict key is the enum member name (a string), not the enum member itself. This keeps `FileSet` JSON-serializable without custom encoding — `to_serializable()` / `from_serializable()` are implemented on the dataclass and round-trip through plain `str` keys and path strings, which is what XCom (Airflow) and task results (Prefect) both accept.

The `batch` task produces a list of serialized `FileSet` strings. The `process` task is dynamically mapped over that list — one task instance per `FileSet` — and each instance instantiates the `Processor` with a single `file_set`. Inside the processor:

```python
csv_files = file_set.get_files(LinkedInFileTypes.CONNECTIONS)
```

## Processor ABC

`Processor` is an abstract base class. Every pipeline provides exactly one concrete subclass:

```python
from abc import ABC, abstractmethod

class Processor(ABC):
    def __init__(self, config: PipelineConfig, run_id: str,
                 start_date: datetime, file_set: FileSet):
        self.config = config
        self.run_id = run_id
        self.start_date = start_date
        self.file_set = file_set

    def process(self) -> dict:
        """Template method: open a DB session and call process_file_set().

        Returns {"success": True, "error": None} on success, or
                {"success": False, "error": <traceback>} on failure.
        Never raises — the store task uses the return value to route files.
        """
        engine = get_engine(schema=self.config.db_schema)
        try:
            with Session(engine) as session:
                self.process_file_set(self.file_set, session)
            return {"success": True, "error": None}
        except Exception:
            return {"success": False, "error": format_exc()}

    @abstractmethod
    def process_file_set(self, file_set: FileSet, session: Session) -> None:
        """Domain logic: parse files, build ORM instances, upsert to database.

        Raise any exception to signal failure. The template method catches it
        and the store task routes the files to quarantine/.
        """
        ...
```

The Processor is instantiated once per `FileSet`, not once per run — fan-out happens at the orchestrator layer via dynamic task mapping. The template method opens a DB session, calls `process_file_set`, and translates any raised exception into `{"success": False, "error": <traceback>}`. The `store` task reads that dict and moves files to `store/` or `quarantine/` accordingly.

## SQLAlchemy Integration

The library provides three helpers that standardize ORM model creation and upsert behavior. See the `sql-schema-modeling` skill for DDL design principles — **the SQLAlchemy models must match the DDL exactly** (same column names, types, constraints, schema). Keep `sqla_models.py` and `tables.ddl` in sync.

### Base class factory

```python
from lib.sql_utils import make_base

# Tables that are inserted and updated in place
UpsertBase = make_base(schema="linkedin", include_update_ts=True)

# Tables that are insert-only (e.g., append-only event logs)
InsertBase = make_base(schema="linkedin", include_update_ts=False)

class Connection(UpsertBase):
    __tablename__ = "connection"
    connection_id = Column(Integer, primary_key=True, autoincrement=True)
    url           = Column(Text, nullable=False, unique=True)
    first_name    = Column(Text)
    last_name     = Column(Text)
    capture_date  = Column(Date, nullable=False)
    # update_ts TIMESTAMPTZ DEFAULT NOW() added automatically
```

`make_base(schema=..., include_update_ts=True)` creates a SQLAlchemy declarative base scoped to the given schema, optionally injecting `update_ts`. Use a single shared `MetaData` object when a pipeline has multiple models so foreign key resolution works correctly.

### Foreign keys

```python
from lib.sql_utils import fkey

class Activity(Base):
    __tablename__ = "activity"
    user_id = Column(BigInteger, fkey("garmin", "user", "user_id"), nullable=False)
```

`fkey(schema, table, column)` returns a `ForeignKey` with the fully schema-qualified reference (`schema.table.column`). Always use this helper — bare `ForeignKey("table.column")` silently omits the schema in multi-schema databases.

### Bulk upsert

```python
from lib.sql_utils import upsert_model_instances

upsert_model_instances(
    session=session,
    model_instances=instances,
    conflict_columns=["url"],                    # Natural/business key, must match a UNIQUE constraint
    on_conflict_update=True,
    update_columns=["first_name", "last_name", "company", "capture_date"],
    latest_check_column="capture_date",          # Only update if the incoming row is newer
    latest_check_inclusive=True,
)
```

Prefer `upsert_model_instances` over bare `INSERT` — it enforces idempotency. The `latest_check_column` guard prevents an older re-ingested file from overwriting more recent data.

## Schema and DDL Organization

```sql
-- schemas.ddl (top-level, run once during setup)
CREATE SCHEMA IF NOT EXISTS linkedin;
CREATE SCHEMA IF NOT EXISTS garmin;

-- pipelines/linkedin/tables.ddl (per-pipeline)
CREATE TABLE IF NOT EXISTS linkedin.connection (
    connection_id SERIAL PRIMARY KEY,
    url           TEXT NOT NULL UNIQUE,
    first_name    TEXT,
    ...
    capture_date  DATE        NOT NULL,
    create_ts     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    update_ts     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Run order: `database.ddl` → `schemas.ddl` → per-pipeline `tables.ddl`. Each file is idempotent (`CREATE IF NOT EXISTS`). Run as the Postgres superuser; the `system2_pipelines` app user only needs `SELECT/INSERT/UPDATE/DELETE` on the data schemas, granted after DDL is applied.

## Anti-Patterns to Avoid

- **Monolithic task**: do not put the entire pipeline in a single function. Split into ingest/batch/process/store so each stage can be retried, monitored, and parallelized independently.
- **Deleting files**: move to quarantine instead. Deletion destroys the audit trail and makes recovery impossible.
- **Database credentials in code**: store in `.env` (gitignored), never hard-coded. Use `python-dotenv` to load at runtime.
- **Logic in the DAG/flow file**: the entry point should only instantiate config and call the factory. Business logic belongs in `process.py`; shared utilities in `lib/`.
- **Raising in `process_file_set` without letting it propagate**: the `Processor` base class catches exceptions to capture the traceback. Do not catch exceptions inside `process_file_set` unless you re-raise — swallowed errors result in `success=True` with corrupted state.
