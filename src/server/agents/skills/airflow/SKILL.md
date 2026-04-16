---
name: airflow
description: Use when building, debugging, scheduling, or testing data pipelines with Apache Airflow v3. Trigger on any code importing airflow, DAG definitions, operator usage, or user mentioning DAGs/tasks/operators/sensors/scheduling.
roles: [conductor, reviewer, worker]
---

# Apache Airflow v3

Official docs: https://airflow.apache.org/docs/apache-airflow/stable/

Pipeline code belongs in the data pipeline repository documented in `infrastructure.md`, not in `~/.system2/`. Use the scratchpad for prototyping DAGs before committing. Check `infrastructure.md` for Airflow deployment details, connection credentials, and existing DAG inventory.

## Core Concepts

**DAG (Directed Acyclic Graph)**: a Python file defining tasks with dependencies. The scheduler parses all `.py` files in the `dags_folder` looking for module-level `DAG` objects or `@dag`-decorated functions. Import DAG and decorators from `airflow.sdk`: `from airflow.sdk import DAG, dag, task`.

**Task**: a unit of work within a DAG. Implemented via operators (traditional) or `@task`-decorated functions (TaskFlow API). A task instance is a specific run of a task for a given data interval.

**Operator**: a class defining what a single task does. Built-in: `PythonOperator`, `BashOperator`, `PostgresOperator`, etc. Operators are parameterized; business logic goes in callables or external modules, not in the operator itself.

**Sensor**: a special operator that waits for a condition (`FileSensor`, `ExternalTaskSensor`, `HttpSensor`). Sensors occupy a worker slot while polling unless you use `mode="reschedule"` (releases the slot between pokes) or deferrable operators (suspends entirely, uses the triggerer).

**Hook**: a lower-level interface to external systems (databases, APIs). Operators use hooks internally. Use hooks directly when no operator covers your interaction pattern.

**Connection**: an Airflow-managed credential record (host, port, login, password, extras JSON). Referenced by `conn_id` in operators and hooks. Lookup order: secrets backend > environment variables > metadata database.

**XCom (Cross-Communication)**: mechanism for tasks to pass small data. TaskFlow API uses XComs implicitly (return values). Traditional operators use `ti.xcom_push()` / `ti.xcom_pull()`. Stored in the metadata database by default. Not suitable for large data (see gotcha #4).

**Task Group**: visual grouping of tasks in the UI. No execution semantics; just a namespace and UI convenience.

**Asset**: a URI representing a logical data asset (renamed from `Dataset` in Airflow 2.x). Tasks declare `outlets=[Asset("...")]` to signal they produce data; DAGs can use `schedule=[Asset("...")]` to trigger when that asset is updated. Import from `airflow.sdk`: `from airflow.sdk import Asset`.

**Trigger rules**: control when a task runs based on upstream task states. Default is `all_success`. Key alternatives: `none_failed` (run if no upstream failed, skips are OK), `all_done` (run regardless of upstream state), `one_success` (run as soon as one upstream succeeds), `none_skipped` (run if no upstream was skipped). Set via `trigger_rule` parameter on any operator.

## Critical Gotchas

### 1. Top-level code runs on every scheduler heartbeat

The scheduler re-parses DAG files every `min_file_process_interval` (default 30 seconds). Any expensive operation at module level (database queries, API calls, heavy imports) runs on every parse. Keep top-level code minimal and fast.

### 2. start_date is not when the DAG first runs

`start_date` is the left boundary of the first data interval, not the wall-clock time of the first run. A DAG with `start_date=Jan 1, schedule="@daily"` creates its first run at Jan 2 (covering the Jan 1-Jan 2 interval). The run's `logical_date` is Jan 1.

### 3. catchup=True can trigger hundreds of backfill runs

If `start_date` is far in the past and `catchup=True` (the default), the scheduler creates a DAG run for every missed interval. Set `catchup=False` unless you explicitly need backfilling.

### 4. XCom is not for large data

The default XCom backend stores data in the metadata database. Pushing large DataFrames bloats the DB and slows the scheduler. The solution: write large data to object storage or a shared filesystem and pass only the path via XCom. For systematic large-data passing, implement a custom XCom backend that transparently stores values in S3/GCS and keeps only the reference in the metadata DB.

### 5. Dynamic tasks at parse time vs runtime

Dynamically generating tasks inside a DAG (looping to create operators) happens at parse time, so the loop input must be available when the scheduler parses the file. For runtime-dynamic fanout, use `.expand()` (dynamic task mapping).

### 6. execution_timeout vs dagrun_timeout

`execution_timeout` limits how long a single task can run. `dagrun_timeout` limits the entire DAG run. If you set neither, a stuck task blocks the DAG indefinitely. Always set both.

### 7. Relative imports break DAG parsing

DAG files are not run as packages. The scheduler adds `dags_folder` to `sys.path` and imports each `.py` file. Use absolute imports from the dags folder root, and ensure `PYTHONPATH` is configured to support your import structure.

### 8. AirflowSkipException does not fail the DAG

Raising `AirflowSkipException` marks the task as "skipped" (not failed). The default `trigger_rule` is `all_success`, so downstream tasks of a skipped task are also skipped. Use `trigger_rule="none_failed"` or `trigger_rule="all_done"` on downstream tasks if they should run regardless.

### 9. Template fields must be declared on the operator

Only fields listed in the operator's `template_fields` are Jinja-rendered. Passing a Jinja template via `op_kwargs` works for `PythonOperator` (because `op_kwargs` is a template field), but not for arbitrary operator arguments unless the operator declares them.

### 10. Connections are cached per process

If you modify a connection's credentials, running tasks that already loaded the connection keep using the old value until the worker process restarts. This bites people who rotate passwords during a DAG run.

### 11. SubDagOperator was removed in Airflow 3

Use TaskGroups for visual grouping, or Assets with data-aware scheduling to trigger separate DAGs.

### 12. DAG code cannot access the metadata database directly

In Airflow 3, tasks communicate with the API server via the Task Execution Interface instead of accessing the metadata DB. Use Task Context, the REST API, or the Python Client for any data that was previously fetched from the DB.

### 13. Legacy import paths are deprecated

`airflow.models.dag.DAG`, `airflow.decorators.task`, and `airflow.datasets.Dataset` still work but emit deprecation warnings and will be removed in a future version. Use `airflow.sdk` for all new code. Run `ruff check --select AIR30 --preview` to flag deprecated imports.

### 14. depends_on_past creates serial execution across runs

`depends_on_past=True` prevents a task from running if the same task in the previous DAG run has not succeeded. Combined with `catchup=True`, all runs execute serially. This is rarely what you want.

## DAG Design

### Factory pattern

Create a function that returns a configured DAG from parameters. This keeps DAG definition DRY and consistent across pipelines.

```python
from airflow.sdk import DAG
from airflow.providers.standard.operators.python import PythonOperator

def create_pipeline(dag_id, schedule, extract_fn, transform_fn):
    dag = DAG(dag_id=dag_id, schedule=schedule, catchup=False, ...)
    with dag:
        extract = PythonOperator(task_id="extract", python_callable=extract_fn)
        transform = PythonOperator(task_id="transform", python_callable=transform_fn)
        extract >> transform
    return dag
```

### Key principles

- **Idempotent tasks**: every task must be safe to re-run. Use UPSERT, not INSERT. Avoid non-reversible side effects.
- **Thin DAG files**: DAG files should instantiate operators and set dependencies. Business logic goes in importable modules.
- **Task granularity**: break pipelines into stages (extract, transform, load) so you can retry, monitor, and parallelize individual stages. Do not put your entire pipeline in one PythonOperator.
- **Atomicity**: each task should represent one logical unit that either fully succeeds or fully fails.

## TaskFlow API vs Traditional Operators

### TaskFlow API (`@task` decorator)

```python
from datetime import datetime
from airflow.sdk import dag, task

@dag(start_date=datetime(2024, 1, 1), schedule="@daily")
def my_pipeline():
    @task
    def extract() -> dict:
        return {"data": [1, 2, 3]}

    @task
    def transform(raw: dict) -> dict:
        return {"data": [x * 2 for x in raw["data"]]}

    raw = extract()
    transform(raw)

my_pipeline()
```

Dependencies are inferred from function calls. XCom passing is implicit (return values). Less boilerplate but all tasks run as Python.

### Traditional operators

```python
from airflow.providers.standard.operators.python import PythonOperator

def extract_fn(**context):
    context["ti"].xcom_push(key="data", value=[1, 2, 3])

def transform_fn(**context):
    data = context["ti"].xcom_pull(task_ids="extract", key="data")
    context["ti"].xcom_push(key="result", value=[x * 2 for x in data])

t1 = PythonOperator(task_id="extract", python_callable=extract_fn)
t2 = PythonOperator(task_id="transform", python_callable=transform_fn)
t1 >> t2
```

Explicit control over XCom keys. Works naturally with non-Python operators and dynamic task mapping.

**When to use which**: TaskFlow for simple Python-only pipelines. Traditional operators when you need dynamic task mapping (`.partial().expand()`), mixed operator types, or explicit XCom serialization control.

## Dynamic Task Mapping

```python
from airflow.sdk import task

@task
def get_file_list() -> list[str]:
    return ["file1.csv", "file2.csv", "file3.csv"]

@task
def process_file(filename: str):
    print(f"Processing {filename}")

# Fan-out at runtime
process_file.expand(filename=get_file_list())
```

With traditional operators:

```python
PythonOperator.partial(
    task_id="process",
    python_callable=process_fn,
).expand(op_args=upstream_task.output)
```

The number of mapped instances is resolved at runtime based on upstream output. Each instance gets its own `map_index`.

## Error Handling

### Retries and timeouts

```python
from datetime import timedelta

default_args = {
    "retries": 3,
    "retry_delay": timedelta(minutes=5),
    "retry_exponential_backoff": True,
    "max_retry_delay": timedelta(hours=1),
    "execution_timeout": timedelta(hours=1),
}
```

Set retries at the DAG level via `default_args`, override per-task on individual operators.

### Skip vs fail

```python
from airflow.exceptions import AirflowSkipException, AirflowFailException

def my_task(**context):
    files = list(Path("/data/inbox").glob("*.csv"))
    if not files:
        raise AirflowSkipException("No files found")

    if not validate_schema(files):
        raise AirflowFailException("Schema violation, retries won't help")
```

`AirflowSkipException`: marks task as skipped, no retry. `AirflowFailException`: immediate failure, no retry.

### Callbacks

```python
def on_failure(context):
    task_id = context["task_instance"].task_id
    error = context.get("exception", "unknown")
    send_alert(f"Task {task_id} failed: {error}")

default_args = {
    "on_failure_callback": on_failure,
    "on_success_callback": on_success,
    "on_retry_callback": on_retry,
}
```

## Connections and Secrets

### Defining connections

**UI**: Admin > Connections. Simplest for development.

**Environment variables**: `AIRFLOW_CONN_{CONN_ID}` with the conn_id uppercased and hyphens replaced by underscores:

```bash
AIRFLOW_CONN_MY_POSTGRES="postgresql://user:pass@host:5432/db"
```

**Secrets backend**: plug in HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager, etc.:

```ini
[secrets]
backend = airflow.providers.hashicorp.secrets.vault.VaultBackend
backend_kwargs = {"connections_path": "airflow/connections", "url": "http://vault:8200"}
```

### Lookup order

1. Secrets backend (if configured)
2. Environment variables
3. Metadata database

For production, use a secrets backend. Avoid storing passwords in environment variables that appear in docker-compose files or version-controlled `.env` files.

## Scheduling

### Cron expressions

```python
DAG(dag_id="my_dag", schedule="0 6 * * *")  # 6 AM UTC daily
```

Presets: `@daily`, `@hourly`, `@weekly`, `@monthly`, `@yearly`, `@once`. `schedule=None` for manual-trigger-only DAGs.

### Data-aware scheduling with Assets

```python
from airflow.sdk import Asset, dag, task

# Producer DAG: declare asset as outlet
@task(outlets=[Asset("s3://bucket/processed_data")])
def produce():
    ...

# Consumer DAG: triggers when the asset is updated
@dag(schedule=[Asset("s3://bucket/processed_data")])
def consumer_dag():
    ...
```

Multiple assets can be combined: `schedule=[Asset("a"), Asset("b")]` triggers when ALL are updated.

### Timetables

For schedules cron cannot express (business days, irregular intervals), implement a custom timetable by subclassing `Timetable`.

## Testing

### DAG integrity tests

```python
from airflow.models import DagBag

def test_no_import_errors():
    dag_bag = DagBag(include_examples=False)
    assert not dag_bag.import_errors, f"Import errors: {dag_bag.import_errors}"

def test_dag_has_tasks():
    dag_bag = DagBag(include_examples=False)
    for dag_id, dag in dag_bag.dags.items():
        assert dag.tasks, f"{dag_id} has no tasks"
```

### Unit testing task callables

Test Python functions independently, mocking Airflow context:

```python
from unittest.mock import MagicMock

def test_extract():
    ti = MagicMock()
    context = {"ti": ti, "dag_run": MagicMock()}
    extract_fn(**context)
    ti.xcom_push.assert_called_once()
```

### End-to-end

```python
dag.test()  # Runs DAG in a single process, no scheduler needed
```

## Debugging

```bash
# Test a single task
airflow tasks test <dag_id> <task_id> <logical_date>

# Run a full DAG (no scheduler)
airflow dags test <dag_id> <logical_date>

# Check for import errors
airflow dags list-import-errors
```

**DAG not appearing in UI**: check `airflow dags list-import-errors`. Common causes: syntax error, import error, missing `airflow`/`DAG` string, file in `.airflowignore`.

**Task stuck in "queued"**: worker slots full or executor cannot reach worker. Check worker health and broker connectivity.

**Task stuck in "running"**: worker may have died without reporting. Check for zombie tasks in the metadata DB. The scheduler has zombie detection.

## Useful Jinja Template Variables

| Variable | Description |
| -------- | ----------- |
| `{{ ds }}` | Logical date as `YYYY-MM-DD` |
| `{{ data_interval_start }}` | Start of the data interval |
| `{{ data_interval_end }}` | End of the data interval |
| `{{ dag_run.run_id }}` | Unique run identifier |
| `{{ dag_run.conf }}` | DAG run configuration (from trigger) |
| `{{ prev_data_interval_end_success }}` | End of previous successful run's interval |
| `{{ var.value.my_variable }}` | Airflow Variables access |
| `{{ conn.my_conn.host }}` | Connection attribute access |

## Pipeline Structure

When building a new pipeline in this repository, follow the conventions in the `pipeline-design` skill. That skill defines the orchestrator-agnostic layer: file state machine, standard task sequence, config dataclass, per-pipeline directory layout, SQLAlchemy integration, and ETL result monitoring. The sections below describe how those abstractions map to Airflow specifically.

### Directory conventions

Each pipeline lives under `pipelines/{name}/` and exposes a `dag.py` that instantiates config and calls `create_dag()`. Keep the DAG file thin (~10 lines); all logic lives in `lib/` or `pipelines/{name}/process.py`.

### Mapping standard tasks to Airflow operators

| Pipeline task | Airflow implementation |
|---|---|
| `ingest` | `PythonOperator(task_id="ingest", python_callable=ingest, op_kwargs={"config": config})` |
| `batch` | `PythonOperator(task_id="batch", ...)` — returns serialized batches via XCom |
| `process` | `PythonOperator.partial(task_id="process", ...).expand(op_args=batch_task.output)` — dynamic task mapping, one instance per batch |
| `store` | `PythonOperator(task_id="store", ...)` — collects mapped process outputs, routes files |

### Dynamic task mapping (process task)

The `process` task uses `.partial().expand()` to fan out over batches at runtime:

```python
from airflow.providers.standard.operators.python import PythonOperator

task_process = PythonOperator.partial(
    task_id="process",
    python_callable=process_wrapper,
    op_kwargs={"config": config, "dag_run_id": "{{ dag_run.run_id }}",
               "dag_start_date": "{{ dag_run.logical_date }}"},
).expand(op_args=task_batch.output)
```

`process_wrapper` deserializes the file set batch from `op_args[0]`, instantiates `config.processor_class`, and calls `.process()`.

### XCom and large data

The `batch` task returns a list of serialized `FileSet` objects via XCom (return value in TaskFlow, or `ti.xcom_push` in traditional operators). Keep batches small: XCom is stored in the metadata database. If file set lists are large, store them in a shared filesystem and pass only the path.

### Config → DAG args

`PipelineConfig.dag_args` returns a dict suitable for `DAG(**config.dag_args)`:

```python
dag = DAG(
    dag_id=config.pipeline_id,
    schedule=config.schedule,
    start_date=config.start_date,
    catchup=False,
    max_active_runs=1,
    default_args={"retries": 2, "retry_delay": timedelta(minutes=5)},
)
```

Always set `catchup=False` and `max_active_runs=1` for file-processing pipelines — concurrent runs writing to the same directories will corrupt state.

### Skip vs. fail

In the `ingest` task, raise `AirflowSkipException` when there are no files to process. This marks the entire DAG run as skipped (not failed) and avoids spurious alerts. Use `trigger_rule="none_failed"` on `batch` and downstream tasks if you want them to run even when `ingest` skips.

## Production Checklist

- **Executor**: `LocalExecutor` for single-machine, `CeleryExecutor` for distributed, `KubernetesExecutor` for elastic isolation
- **Metadata DB**: always PostgreSQL in production (never SQLite)
- **Timeouts**: `execution_timeout` on all tasks, `dagrun_timeout` on all DAGs
- **`max_active_runs`**: set to prevent resource exhaustion (default 1 for ETL pipelines)
- **Remote logging**: enable S3/GCS logging so logs survive container restarts
- **DB maintenance**: run `airflow db clean` periodically to prune old DAG runs, task instances, and XCom entries
- **Health checks**: monitor scheduler, workers, and triggerer
- **DAG versioning**: DAG files in Git, deployed via CI/CD
