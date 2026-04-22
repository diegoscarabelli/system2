---
name: prefect
description: Use when building, debugging, deploying, or testing data pipelines with Prefect v3. Trigger on any code importing prefect, prefect YAML config, or user mentioning Prefect flows/tasks/deployments/workers.
roles: [conductor, reviewer, worker]
---

# Prefect v3 Data Pipelines

Official docs: https://docs.prefect.io/v3

Pipeline code belongs in the data pipeline repository documented in `infrastructure.md`, not in `~/.system2/`. Use the scratchpad for prototyping flows before committing to the repo.

## Core Concepts

**Flows** (`@flow`): the top-level unit of work. Key params: `name`, `retries`, `retry_delay_seconds`, `timeout_seconds`, `log_prints`, `task_runner`, `validate_parameters`.

**Tasks** (`@task`): discrete units within a flow. Key params: `name`, `retries`, `retry_delay_seconds`, `timeout_seconds`, `tags`, `cache_policy`, `cache_expiration`, `log_prints`. Each `@task` has overhead from state tracking and API calls, so don't wrap trivially cheap operations. Use raw Python functions for sub-millisecond work within a task.

**Deployments**: where/when/how a flow runs. Two approaches:
- `flow.serve()`: runs in-process, no worker needed. Good for dev. If the process dies, scheduled runs stop.
- `flow.deploy()`: infrastructure-backed (Docker, K8s, ECS). Schedules persist independently.

**Work pools**: bridge between orchestration and infrastructure (Hybrid/Push/Managed).

**Workers**: lightweight polling services that pick up runs from work pools. Poll every 15s by default.

**Events and Automations**: Prefect emits events for every state change (flow/task started, completed, failed, etc.). Automations are reactive rules that trigger actions (send notifications, pause deployments, run flows, cancel runs) in response to event patterns. Configure via the UI or `prefect automation create`. Use automations instead of in-flow alerting for cross-deployment concerns like SLA monitoring or cascading failure response.

## Critical Gotchas

### 1. Flows succeed despite failed tasks

Flows only fail if an uncaught exception propagates or the return value is a `Failed` state. Swallowed task failures result in a `Completed` flow.

```python
# WRONG: flow completes even if extract() fails
@flow
def pipeline():
    data = extract.submit()  # failure is swallowed
    transform.submit(data)

# RIGHT: let exceptions propagate
@flow
def pipeline(source: str):
    data = extract(source)  # exception propagates, flow fails
    transform(data)
```

### 2. Automatic task caching

Tasks cache by default when called with identical inputs in the same flow run. Side-effecting tasks (writing files, sending notifications) get silently skipped on repeated calls.

```python
# FIX: disable caching for side-effecting tasks
from prefect.cache_policies import NONE

@task(cache_policy=NONE)
def send_notification(msg: str):
    requests.post(webhook, json={"text": msg})
```

Available cache policies: `INPUTS`, `TASK_SOURCE`, `RUN_ID`, `FLOW_PARAMETERS`, `NONE`.

### 3. MissingContextError from get_run_logger()

`get_run_logger()` only works inside active flow/task context. Fails in: tests (use `prefect_test_harness`), state change hooks (use `flow_run_logger`/`task_run_logger`), `ThreadPoolExecutor` threads (use `with_context` wrapper), code outside `@flow`/`@task`.

### 4. Sync task timeouts with ThreadPoolTaskRunner

Timeouts cannot interrupt blocking operations (`time.sleep()`, file I/O) in sync tasks under `ThreadPoolTaskRunner`. Workarounds: use `ProcessPoolTaskRunner`, convert to async, split blocking ops into chunks, or use library-native timeouts.

### 5. PrefectFutures are sync-only

Never `await` futures. `submit()` is always synchronous, even in async flows.

```python
# WRONG
future = await my_task.submit(x)

# RIGHT
future = my_task.submit(x)
result = future.result()
```

### 6. Mutable unmapped objects shared by reference

```python
# GOTCHA: all mapped tasks share the same dict, race conditions possible
result = my_task.map(items, unmapped(config))

# FIX: deepcopy inside the task, or use immutable types
```

### 7. Don't mix asyncio primitives

Never call `asyncio.run()` inside flows/tasks, don't manually create/close event loops, don't use `nest_asyncio`. Use Prefect's `run_coro_as_sync` if bridging is needed.

### 8. Result storage doesn't persist across containers

Default storage is `~/.prefect/storage/` (local filesystem). In Docker/K8s, this is ephemeral. Use remote storage (S3, GCS, Azure) for distributed execution.

## Error Handling and Resilience

### Retries with backoff

```python
from prefect.tasks import exponential_backoff

@task(
    retries=5,
    retry_delay_seconds=exponential_backoff(backoff_factor=2),  # 2, 4, 8, 16, 32
    retry_jitter_factor=0.5,  # prevents thundering herd
)
def call_api(url: str):
    response = requests.get(url)
    response.raise_for_status()
    return response.json()
```

`retry_delay_seconds` accepts: a number, a list (`[1, 10, 60]`), or `exponential_backoff()`.

### Conditional retries

```python
def retry_on_transient(task, task_run, state):
    exc = state.result(raise_on_failure=False)
    return isinstance(exc, (ConnectionError, TimeoutError))

@task(retries=3, retry_condition_fn=retry_on_transient)
def fragile_task(): ...
```

### State change hooks

```python
from prefect.logging import flow_run_logger

def on_failure(flow, flow_run, state):
    logger = flow_run_logger(flow_run)  # NOT get_run_logger()
    logger.error(f"Flow {flow_run.name} failed: {state.message}")

@flow(on_failure=[on_failure])
def my_pipeline(): ...
```

### Transactions for atomicity

```python
from prefect.transactions import transaction

@task
def write_file(contents: str, path: str):
    with open(path, "w") as f:
        f.write(contents)

@write_file.on_rollback
def delete_file(txn):
    os.unlink("output.csv")

@flow
def etl():
    with transaction():
        write_file("data", "output.csv")
        quality_check()  # if this fails, write_file's rollback fires
```

Key: default isolation is `READ_COMMITTED`. Use `SERIALIZABLE` + lock manager for concurrent safety.

## Concurrency and Parallelism

### Task Runners

| Runner | Use Case |
|--------|----------|
| `ThreadPoolTaskRunner` (default) | I/O-bound (API calls, DB queries) |
| `ProcessPoolTaskRunner` | CPU-bound (data transformation) |
| `DaskTaskRunner` (`prefect[dask]`) | Distributed across machines |
| `RayTaskRunner` (`prefect[ray]`) | Distributed with Ray |

### Submit and Map

```python
# Single
future = my_task.submit(arg)

# Map over iterables
futures = my_task.map([1, 2, 3], unmapped(config))

# Automatic dependency: passing a future makes Prefect wait
future_a = task_a.submit()
future_b = task_b.submit(future_a)  # waits for task_a

# Explicit dependency without data flow
c = task_c.submit(wait_for=[a, b])
```

### Global concurrency limits

```python
from prefect.concurrency.sync import concurrency

@task
def call_api(url):
    with concurrency("api-rate-limit", occupy=1):
        return requests.get(url).json()

# Create: prefect gcl create api-rate-limit --limit 10
```

### Resolve futures before flow exit

Unresolved futures can cause silent failures. Always resolve or return them.

## Data Passing Best Practices

- Pass references (S3 keys, file paths) between tasks, not large datasets.
- Use `cache_result_in_memory=False` for tasks producing large results.
- Use `result_serializer="compressed/pickle"` for large results.
- Configure remote `result_storage` for distributed/containerized environments.

```python
@task
def extract(date: str) -> str:
    df = pd.read_sql(query, conn)
    path = f"s3://bucket/extract/{date}.parquet"
    df.to_parquet(path)
    return path  # pass reference, not data
```

## Configuration and Secrets

**Variables** (non-sensitive, arbitrary JSON):
```python
from prefect.variables import Variable
Variable.set("environment", "production", overwrite=True)
env = Variable.get("environment", default="development")
```

**Secret blocks** (encrypted at rest):
```python
from prefect.blocks.system import Secret
Secret(value="my-api-key").save("prod-api-key")
api_key = Secret.load("prod-api-key").get()
```

**Credentials blocks** (provider-specific):
```python
from prefect_aws.credentials import AwsCredentials
creds = AwsCredentials.load("prod-aws")
session = creds.get_boto3_session()
```

Use `SecretStr`/`SecretDict` in custom blocks for obfuscated display.

## Configuration Hierarchy

Highest precedence first:

1. Environment variables (`PREFECT_*`)
2. `.env` files in working directory
3. Profiles (`~/.prefect/profiles.toml`)

Key settings: `PREFECT_API_URL`, `PREFECT_API_KEY`, `PREFECT_RESULTS_PERSIST_BY_DEFAULT`, `PREFECT_LOGGING_LOG_PRINTS`, `PREFECT_TASK_DEFAULT_RETRIES`, `PREFECT_WORKER_QUERY_SECONDS`.

## Scheduling

**Cron**: `CronSchedule(cron="0 9 * * MON-FRI", timezone="America/New_York")`

**Interval**: accepts seconds, ISO 8601 (`PT10M`), or time strings. `anchor_date` is a computation reference, not a start time.

**RRule**: for complex calendar logic. `COUNT` unsupported; use `UNTIL`.

**DST**: cron/rrule adjust based on schedule times (possible duplicate runs on fall-back). Intervals < 24h follow UTC.

**Scheduler limits**: max 100 runs, max 100 days out. Changing a schedule removes unstarted runs.

## Testing

### With test harness (session-scoped for speed)

```python
import pytest
from prefect.testing.utilities import prefect_test_harness

@pytest.fixture(autouse=True, scope="session")
def prefect_test_fixture():
    with prefect_test_harness():
        yield

def test_my_flow():
    result = my_flow()
    assert result == expected
```

### Unit testing with .fn() (fastest, no Prefect overhead)

```python
def test_extract_logic():
    result = extract.fn(source="test-db")  # bypasses state tracking, retries, API
    assert result == expected_data
```

### Common test issues

| Issue | Fix |
|-------|-----|
| Server timeout | `prefect_test_harness(server_startup_timeout=60)` |
| `MissingContextError` | Use `.fn()` or `disable_run_logger()` |
| Stale state | Function-scoped fixture |

## Debugging

```bash
# List recent flow runs with state
prefect flow-run ls

# Inspect a specific flow run (logs, task states, parameters)
prefect flow-run inspect <flow-run-id>

# List deployments and their schedules
prefect deployment ls

# Inspect deployment configuration
prefect deployment inspect <deployment-name>/<flow-name>

# Check worker health and active work pools
prefect work-pool ls
prefect worker ls

# View server/client config
prefect config view

# Check connectivity to API
prefect version
```

**Checking flow run state programmatically** (preferred over parsing CLI tables):

```bash
# Get state of a specific flow run via the REST API
curl -s http://localhost:4200/api/flow_runs/<flow-run-id> | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['state']['type'], r['state'].get('message',''))"
```

Use this instead of repeatedly running `prefect flow-run ls` and trying to parse truncated table output.

**Flow run stuck in "Pending"**: no worker polling the work pool, or the work pool is paused. Check `prefect work-pool ls` and `prefect worker ls`.

**Flow run stuck in "Running"**: worker may have crashed without reporting. Check worker logs. Runs exceeding `timeout_seconds` are eventually marked as failed.

**Tasks not visible in UI**: ensure they use `@task` decorator (plain function calls are not tracked). Check that `log_prints=True` is set if expecting print output.

## Local Server and Deployments

### Starting the server

```bash
prefect server start                                        # runs on http://localhost:4200
prefect config set PREFECT_API_URL=http://localhost:4200/api # point CLI at local server
```

The Prefect UI is available at `http://localhost:4200` once the server is running.

### Work pool and worker

A work pool + worker pair is required for deployments (not needed for `flow.serve()` or direct `python -m` runs):

```bash
prefect work-pool create default --type process
prefect worker start --pool default                         # keep running in background
```

### Running flows

```bash
# Direct execution (no server needed, good for development)
PYTHONPATH=dags python -m pipelines.<name>.flow

# Via deployment (requires server + worker)
cd dags
prefect deploy pipelines/<name>/flow.py:flow --name <name>-dev --work-pool default
prefect deployment run '<flow-name>/<name>-dev'
```

`PYTHONPATH=dags` is required so `from lib.xxx import yyy` resolves. Airflow/Astro auto-adds `dags/` to the path, but Prefect does not.

### Prefect Cloud

For managed orchestration (no local server): `prefect cloud login` (browser auth). All CLI commands work the same against Cloud.

## Deployment Patterns

### Docker (prefect.yaml)

```yaml
build:
  - prefect_docker.deployments.steps.build_docker_image:
      id: build-image
      image_name: "{{ $IMAGE_NAME }}"
      tag: latest
      dockerfile: auto
      platform: "linux/amd64"  # IMPORTANT on ARM machines

deployments:
  - name: prod-etl
    entrypoint: flows/etl.py:run_etl
    work_pool:
      name: docker-pool
      job_variables:
        image: "{{ build-image.image }}"
    schedules:
      - cron: "0 6 * * *"
        timezone: America/New_York
```

### Git-based source

```python
my_flow.from_source(
    source="https://github.com/org/repo.git",
    entrypoint="flows/etl.py:etl_pipeline",
).deploy(name="prod-etl", work_pool_name="k8s-pool")
```

### CI/CD

```bash
prefect deploy --all --no-prompt
```

## Pipeline Structure

When building a new pipeline in this repository, follow the conventions in the `pipeline-design` skill. That skill defines the orchestrator-agnostic layer: file state machine, standard task sequence, config dataclass, per-pipeline directory layout, SQLAlchemy integration, and ETL result monitoring. The sections below describe how those abstractions map to Prefect specifically.

### Directory conventions

Each pipeline lives under `dags/pipelines/{name}/` and exposes a `flow.py` that instantiates config and calls `create_flow()`. Keep the flow file thin (~10 lines); all logic lives in `dags/lib/` or `dags/pipelines/{name}/process.py`.

Prefect is indifferent to the folder name — everything lives under `dags/` only because Astro CLI and native Airflow hardcode that directory. Prefect does **not** auto-add `dags/` to PYTHONPATH, so:

- **Local dev**: `PYTHONPATH=dags python -m pipelines.{name}.flow`
- **Deployments**: `cd dags && prefect deploy pipelines/{name}/flow.py:flow --name {name}-prod --work-pool default`

Workers run the entrypoint from the directory Prefect recorded at deploy time, so deploying from `dags/` keeps the `from lib.xxx import yyy` imports resolvable at runtime.

### Mapping standard tasks to Prefect

| Pipeline task | Prefect implementation |
|---|---|
| `ingest` | `@task def ingest(config)` — scans `ingest/`, routes files, raises `Abort` or returns count |
| `batch` | `@task def batch(config)` — returns a list of serialized `FileSet` objects |
| `process` | `@task def process_batch(serialized_batch, config)` — mapped via `process_batch.map(...)`, one instance per `FileSet` |
| `store` | `@task def store(all_results, config)` — collects mapped process return values, routes files to `store/` or `quarantine/` |

### Dynamic task mapping (process task)

Use `task.map()` to fan out over batches at runtime:

```python
@task(cache_policy=NONE)
def process_batch(serialized_batch: str, config: PipelineConfig) -> dict:
    file_set = FileSet.from_serializable(serialized_batch)
    processor = config.processor_class(
        config=config, run_id=..., start_date=..., file_set=file_set,
    )
    return processor.process()  # {"files": [...], "success": bool, "error": str|None}

@flow
def pipeline(config: PipelineConfig) -> None:
    ingest(config)
    batches = batch(config)
    results = process_batch.map(batches, unmapped(config))
    store(results, config)
```

Set `cache_policy=NONE` on `process_batch` — it writes files and database rows, so caching would silently skip work on repeated calls. Note the Processor takes a **singular** `file_set` (not a list); fan-out happens at the Prefect layer via `task.map()`, and each mapped instance gets one `FileSet`.

### Result passing and large data

Pass serialized `FileSet` objects (JSON strings) between tasks, not raw `Path` objects or DataFrames. For large file inventories, write the batch list to a shared filesystem and pass only the path between `batch` and `process_batch`.

Use `cache_result_in_memory=False` on tasks that return large intermediate results.

### Skip vs. fail

When `ingest` finds no files, raise `Abort` (marks the flow run as cancelled, not failed) or return early and have downstream tasks check a sentinel value. Do not raise a bare exception for an empty inbox — that would mark the flow as failed and trigger alerts.

### Config → flow parameters

`PipelineConfig` is a plain dataclass. Pass it directly to `@flow` functions — Prefect serializes dataclass parameters automatically. For scheduled deployments, store the config as a `Variable` or embed it in the deployment's `parameters` dict:

```python
flow.deploy(
    name="linkedin-prod",
    work_pool_name="process-pool",
    parameters={"config": asdict(linkedin_config)},
    schedules=[CronSchedule(cron="0 9 * * *", timezone="UTC")],
)
```

## Production Checklist

- **API server**: Prefect Cloud or self-hosted Prefect server (never rely on ephemeral mode)
- **Work pool type**: Docker or Kubernetes for isolation, process pool for simple setups
- **Result storage**: remote (S3/GCS/Azure), never local filesystem in containers
- **Timeouts**: `timeout_seconds` on all flows and tasks
- **Retries**: `retries` + `retry_delay_seconds` on tasks that call external systems
- **Concurrency limits**: global concurrency limits on rate-limited APIs
- **Automations**: failure notifications, SLA alerts, deployment pause on repeated failures
- **Logging**: `log_prints=True` on flows, structured logging for observability
- **Health checks**: monitor worker processes, work pool queue depth
- **Flow versioning**: flows in Git, deployed via CI/CD with `prefect deploy`
