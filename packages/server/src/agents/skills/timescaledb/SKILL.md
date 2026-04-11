---
name: timescaledb
description: Use when designing schemas, writing queries, configuring compression/retention/continuous aggregates, or troubleshooting performance for TimescaleDB hypertables. Trigger on any SQL referencing hypertables, time_bucket, continuous aggregates, or TimescaleDB functions.
---

# TimescaleDB

Official docs: https://docs.timescale.com

Pipeline code belongs in the data pipeline repository documented in `infrastructure.md`, not in `~/.system2/`. Use the scratchpad for prototyping queries before committing. Check `infrastructure.md` for connection details and existing hypertable schemas.

## Core Concepts

**Hypertables**: PostgreSQL tables auto-partitioned into time-based chunks. Every hypertable requires a `TIMESTAMPTZ` column (the time column) that determines how rows are assigned to chunks. Standard SQL works transparently.

```sql
SELECT create_hypertable('metrics', by_range('timestamp', INTERVAL '7 days'));
```

**Chunks**: physical tables, each covering a non-overlapping time range. Compression, retention, and continuous aggregates all operate at chunk level. The query planner evaluates every chunk's constraint during planning, so chunk count directly affects planning time.

**Chunk sizing**: target one chunk (with indexes) fitting in ~25% of `shared_buffers`. Alternative: ~25M rows per chunk. Wrong sizing causes massive planning overhead (4,000 chunks with 1-hour interval: 443ms planning vs 26 chunks with 7-day interval: 5ms planning).

**Compression**: converts multiple rows sharing the same segmentby column values into a single row. Non-segmentby columns are stored as arrays, ordered by the orderby column (usually time DESC) in mini-batches of up to 1,000 rows. TimescaleDB stores min/max timestamps per batch, enabling query pruning without full decompression. Properly configured, compression achieves 90-95% space reduction.

**Continuous aggregates**: materialized views specialized for time-series. Unlike regular materialized views, they refresh incrementally (only processing new/changed data since the last refresh). Defined by a `SELECT` with `GROUP BY time_bucket(...)` over a single hypertable. Internally implemented as hypertables themselves (materialization hypertables), so they support compression and retention policies.

**Retention policies**: automated chunk-level deletion. Instead of row-level `DELETE` (which generates massive WAL), retention policies drop entire chunks instantly.

## Critical Gotchas

### 1. Unique indexes must include the time column

All unique indexes and primary keys must include the partitioning column. This is the most surprising constraint for PostgreSQL users.

```sql
-- FAILS on create_hypertable
CREATE TABLE metrics (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL,
    value DOUBLE PRECISION
);

-- WORKS
CREATE TABLE metrics (
    device_id INT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    value DOUBLE PRECISION,
    PRIMARY KEY (device_id, timestamp)
);
```

### 2. Foreign keys between hypertables are NOT supported

Hypertable -> regular table: supported. Regular table -> hypertable: supported (v2.16+). Hypertable -> hypertable: not supported. Keep dimension tables as regular PostgreSQL tables.

### 3. Queries without time predicates scan all chunks

Without a time range in WHERE, PostgreSQL cannot exclude chunks and must scan all of them. Always include a time filter.

```sql
-- BAD: scans every chunk
SELECT avg(value) FROM readings WHERE device_id = 42;

-- GOOD: chunk pruning works
SELECT avg(value) FROM readings
WHERE device_id = 42 AND timestamp >= now() - INTERVAL '7 days';
```

### 4. Non-sargable predicates prevent chunk pruning

```sql
-- BAD: function on column prevents index/chunk pruning
WHERE timestamp::date = '2025-01-01'
WHERE date_trunc('day', timestamp) = '2025-01-01'

-- GOOD: sargable range
WHERE timestamp >= '2025-01-01' AND timestamp < '2025-01-02'
```

### 5. UPDATEs that move rows between chunks are not supported

UPDATE statements that change the time column across a chunk boundary fail. This also applies to upserts (`INSERT ... ON CONFLICT UPDATE`) when the updated time value falls in a different chunk.

### 6. DML on compressed chunks is expensive

Inserts into compressed chunks trigger decompression-recompression. Deletes on non-segmentby columns are expensive. Design pipelines to be append-only. Set `compress_after` >= one chunk interval.

### 7. Many DDL operations are blocked on compressed hypertables

Once any chunk is compressed, you cannot: add/drop UNIQUE constraints or PRIMARY KEYs, create UNIQUE INDEXes, alter segmentby columns, or change column data types. Segmentby columns can only be changed when all chunks are uncompressed (often impractical for large tables). Plan your schema and compression settings before data accumulates.

### 8. Adding NOT NULL columns requires decompressing all chunks

Always add new columns as nullable to avoid full decompression.

### 9. pg_dump decompresses all data

A 25GB compressed database produces ~220GB dump. Use `pg_basebackup` for physical backups, or pipe pg_dump through gzip.

### 10. Row-level DELETE is extremely expensive

`DELETE FROM table WHERE timestamp < X` generates massive WAL and is orders of magnitude slower than retention policies, which drop entire chunks instantly.

### 11. max_locks_per_transaction default is too low

Each chunk acquires locks. With hundreds of chunks, the default 64 causes "out of shared memory" errors. Set to 512+.

### 12. Continuous aggregate backfill blindness

Inserting historical data into already-materialized buckets does NOT update the aggregate until the next refresh covers that range. Manually refresh if needed:

```sql
CALL refresh_continuous_aggregate('metrics_hourly', '2024-01-01', '2024-02-01');
```

## Schema Design

### Dimension tables

Store metadata in regular PostgreSQL tables. Join to hypertables with time-bounded queries.

```sql
CREATE TABLE devices (
    device_id INT PRIMARY KEY,
    name TEXT NOT NULL,
    location TEXT
);

CREATE TABLE readings (
    timestamp TIMESTAMPTZ NOT NULL,
    device_id INT NOT NULL REFERENCES devices(device_id),
    value DOUBLE PRECISION NOT NULL
);
SELECT create_hypertable('readings', by_range('timestamp'));
```

Include `ts_start`, `ts_end`, `ts_last_seen` in dimension tables for efficient discovery queries without scanning the hypertable.

### Uniqueness and compression interaction

If a hypertable has a UNIQUE constraint or PRIMARY KEY, all columns in the constraint except the time column must be segmentby columns. This locks your compression design to your uniqueness constraint. To maximize flexibility, prefer UNIQUE INDEXes over constraints: they enforce uniqueness without restricting segmentby choices.

### Indexing

TimescaleDB auto-creates a time index. Add composite indexes matching common query patterns. Drop unused secondary indexes (two unnecessary indexes reduce INSERT throughput by 20-40%).

```sql
CREATE INDEX ON readings (device_id, timestamp DESC);
```

## Compression

### Configuration

```sql
ALTER TABLE metrics SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_id',    -- columns in WHERE filters
    timescaledb.compress_orderby = 'timestamp DESC'   -- almost always time DESC
);
SELECT add_compression_policy('metrics', INTERVAL '7 days');
```

Both ALTER TABLE (how) and add_compression_policy (when) are required. ALTER TABLE alone does nothing.

**segmentby**: low-to-medium cardinality columns you filter on (100-10K unique values per chunk, >=100 rows per segment). Do not use the time column as segmentby (chunking already partitions by time, and its high cardinality kills compression). **orderby**: almost always the time column DESC.

### Compressing continuous aggregates

Segmentby columns are implicitly the GROUP BY columns, so `compress_segmentby` is not used:

```sql
ALTER MATERIALIZED VIEW metrics_hourly SET (timescaledb.compress);
SELECT add_compression_policy('metrics_hourly', INTERVAL '30 days');
```

If a continuous aggregate has both a compression policy and a refresh policy, the compression interval must be greater than the refresh policy's `start_offset`.

### Monitoring compression

```sql
-- Uncompressed chunks that should be compressed
SELECT chunk_name, range_start, range_end
FROM timescaledb_information.chunks
WHERE NOT is_compressed AND range_end < now() - INTERVAL '2 hours';

-- Compression ratios (healthy: 8x-20x; below 3x: investigate)
SELECT
    pg_size_pretty(before_compression_total_bytes) AS before,
    pg_size_pretty(after_compression_total_bytes) AS after,
    before_compression_total_bytes::numeric /
        NULLIF(after_compression_total_bytes, 0) AS ratio
FROM hypertable_compression_stats('metrics');
```

## Continuous Aggregates

```sql
CREATE MATERIALIZED VIEW metrics_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', timestamp) AS bucket,
    device_id,
    avg(value) AS avg_value,
    count(*) AS sample_count
FROM readings
GROUP BY bucket, device_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_hourly',
    start_offset  => INTERVAL '3 days',
    end_offset    => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour'
);
```

**start_offset**: how far back to refresh (must cover late-arriving data). **end_offset**: exclude incomplete current bucket. **schedule_interval**: how often to run.

### Limitations

Not supported in continuous aggregate definitions: window functions, ORDER BY inside aggregates, DISTINCT inside aggregates, FILTER clauses, JOINs. UPDATE/DELETE on the source hypertable are invisible until the next refresh.

To inspect materialization hypertables:

```sql
SELECT view_name, materialization_hypertable_name
FROM timescaledb_information.continuous_aggregates;
```

### Real-time vs materialized-only

By default, queries combine materialized + raw data. To show only materialized data:

```sql
ALTER MATERIALIZED VIEW metrics_hourly SET (timescaledb.materialized_only = true);
```

## Retention and Data Lifecycle

```sql
SELECT add_retention_policy('metrics', INTERVAL '365 days');
```

### Tiered lifecycle pattern

1. **Hot** (uncompressed, 1-7 days): real-time queries
2. **Warm** (compressed, weeks-months): good read performance, 90%+ space reduction
3. **Cold** (continuous aggregate only, months-years): summarized historical data
4. **Drop**: raw data deleted, aggregates persist

Stagger compression, retention, and refresh policies by 5-15 minutes to avoid thundering herd.

## Ingestion

| Method | Relative Speed | Use Case |
| ------ | -------------- | -------- |
| Single INSERT | 1x | Avoid in pipelines |
| Batch INSERT (500-5K rows) | ~20x | Application code |
| INSERT .. UNNEST | ~40x | Best hybrid approach |
| COPY FROM STDIN | ~50x | ETL/batch pipelines |

For bulk loads: create indexes after loading, run `ANALYZE` after, use `timescaledb-parallel-copy` for parallel ingestion.

## Useful Functions

```sql
-- time_bucket: aggregate by time intervals
SELECT time_bucket('5 minutes', timestamp) AS bucket, avg(value)
FROM readings WHERE timestamp >= now() - INTERVAL '1 day'
GROUP BY bucket ORDER BY bucket;

-- Gap filling with interpolation
SELECT
    time_bucket_gapfill('1 hour', timestamp) AS bucket,
    locf(avg(value)) AS value_locf,
    interpolate(avg(value)) AS value_interp
FROM readings
WHERE timestamp >= '2024-01-01' AND timestamp < '2024-02-01'
GROUP BY bucket;

-- First/last value
SELECT device_id,
    first(value, timestamp) AS earliest,
    last(value, timestamp) AS latest
FROM readings GROUP BY device_id;
```

`time_bucket_gapfill` requires explicit start/end bounds in WHERE.

## Monitoring

```sql
-- Background worker health
SELECT
    (SELECT count(*) FROM timescaledb_information.jobs WHERE scheduled) AS active_jobs,
    (SELECT count(*) FROM timescaledb_information.job_stats
     WHERE last_run_status = 'Failed') AS failed_jobs;

-- Continuous aggregate freshness
SELECT view_name, last_run_status,
    now() - last_successful_finish AS staleness
FROM timescaledb_information.continuous_aggregates ca
JOIN timescaledb_information.jobs j
    ON j.hypertable_name = ca.materialization_hypertable_name
JOIN timescaledb_information.job_stats USING (job_id);

-- Chunk count per hypertable (alert if >500 with stable ingest)
SELECT hypertable_name, count(*) AS chunks
FROM timescaledb_information.chunks
GROUP BY hypertable_name ORDER BY chunks DESC;
```

## PostgreSQL Configuration

```text
shared_preload_libraries = 'timescaledb'
max_locks_per_transaction = 512
timescaledb.max_background_workers = 8
timescaledb.enable_chunk_skipping = on
```

Autovacuum tuning for high-write hypertables:

```sql
ALTER TABLE metrics SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_analyze_scale_factor = 0.02
);
```
