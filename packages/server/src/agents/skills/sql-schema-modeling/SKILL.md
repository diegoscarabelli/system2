---
name: sql-schema-modeling
description: Use when designing database schemas, choosing between normalization levels, modeling dimensional/star schemas, deciding on JSON columns vs relational columns, choosing materialization strategies (materialized views vs pipeline-built tables), or reviewing table structures. Trigger on CREATE TABLE statements, schema design discussions, materialization decisions, or questions about data modeling patterns.
roles: [conductor, reviewer, worker]
---

# SQL Schema Modeling

## Normalization

Normalization eliminates data redundancy and update anomalies by decomposing tables.

**1NF**: every column contains atomic values, every row is uniquely identifiable. No arrays, no comma-separated lists.

```sql
-- Violates 1NF
CREATE TABLE orders_bad (
    order_id INT PRIMARY KEY,
    products TEXT  -- 'Widget, Gadget, Sprocket'
);

-- 1NF: separate rows
CREATE TABLE order_items (
    order_id   INT,
    product_id INT,
    quantity   INT,
    PRIMARY KEY (order_id, product_id)
);
```

**2NF**: no partial dependencies. Every non-key column depends on the entire composite key, not just part of it. Only relevant for composite keys.

**3NF**: no transitive dependencies. Non-key columns depend directly on the primary key, not on other non-key columns.

```sql
-- Violates 3NF: city depends on zip_code, not customer_id
CREATE TABLE customers_bad (
    customer_id INT PRIMARY KEY,
    zip_code    TEXT,
    city        TEXT  -- customer_id -> zip_code -> city
);

-- 3NF: separate the transitive dependency
CREATE TABLE zip_codes (
    zip_code TEXT PRIMARY KEY,
    city     TEXT
);

CREATE TABLE customers (
    customer_id INT PRIMARY KEY,
    zip_code    TEXT REFERENCES zip_codes(zip_code)
);
```

**BCNF**: for every functional dependency X -> Y, X must be a superkey. Stricter than 3NF; handles edge cases with overlapping candidate keys.

### When to stop

Aim for 3NF as a baseline for OLTP systems. Denormalize deliberately for read-heavy workloads (analytics, reporting). Always denormalize based on measured query patterns, not guesswork. Keep normalized source tables and create denormalized read tables or views for read paths (see Materialization Strategy for when to use materialized views vs pipeline-built tables).

## Dimensional Modeling (Star Schema)

### Fact tables

Store quantitative metrics (amounts, counts, quantities) plus foreign keys to dimension tables. Each row represents a business event at the most atomic grain.

**Declare the grain first**: "one row per order line item" or "one row per customer per day." Never mix grains in a single fact table.

```sql
CREATE TABLE fact_sales (
    sale_key        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    date_key        INT NOT NULL REFERENCES dim_date(date_key),
    product_key     INT NOT NULL REFERENCES dim_product(product_key),
    customer_key    INT NOT NULL REFERENCES dim_customer(customer_key),
    quantity_sold   INT NOT NULL,
    unit_price      NUMERIC(10,2) NOT NULL,
    total_amount    NUMERIC(12,2) NOT NULL,
    discount_amount NUMERIC(10,2) DEFAULT 0
);
```

Fact types: additive (can be summed across all dimensions), semi-additive (summed across some, e.g. account balances), non-additive (ratios, percentages).

### Dimension tables

Provide descriptive context (who, what, where, when). In a star schema, dimensions are denormalized: all related attributes in a single table to minimize joins.

```sql
CREATE TABLE dim_customer (
    customer_key    INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id     TEXT NOT NULL,  -- natural/business key (not unique: SCD Type 2 creates multiple rows per customer)
    full_name       TEXT NOT NULL,
    email           TEXT,
    city            TEXT,
    state           TEXT,
    country         TEXT,
    segment         TEXT,
    effective_date  DATE NOT NULL,
    expiration_date DATE,
    is_current      BOOLEAN DEFAULT TRUE
);
```

Use integer surrogate keys on all dimension tables. Store natural/business keys as regular attributes. For SCD Type 1 dimensions (no history), add a UNIQUE constraint on the natural key. For SCD Type 2 (historical rows), the natural key is not unique; use a composite unique on `(customer_id, effective_date)` instead.

### Star vs snowflake

**Star**: dimensions are denormalized (flat). Fewer joins, simpler queries, faster reads. Some data duplication. Default choice for analytics.

**Snowflake**: dimensions are normalized into sub-tables. Less redundancy, but more joins. Use only when dimensions have deep hierarchies with heavily repeated data.

### Slowly Changing Dimensions (SCD)

**Type 1 (Overwrite)**: replace old value with new. History is lost. Use for corrections or non-historical attributes.

**Type 2 (Add Row)**: insert a new row, expire the old one (`is_current`, `effective_date`, `expiration_date`). Preserves full history. Most common type.

```sql
-- Expire old row
UPDATE dim_customer
SET expiration_date = CURRENT_DATE - 1, is_current = FALSE
WHERE customer_id = 'CUST-1042' AND is_current = TRUE;

-- Insert new version
INSERT INTO dim_customer (customer_id, full_name, city, effective_date, is_current)
VALUES ('CUST-1042', 'Alice Smith', 'Chicago', CURRENT_DATE, TRUE);
```

**Type 3 (Add Column)**: add `previous_*` columns. Tracks exactly one prior value. Limited: oldest value is lost on subsequent changes.

## Wide vs Narrow Tables

| Aspect | Wide | Narrow |
|--------|------|--------|
| Reads | Direct column access, fast | Requires pivots or conditional aggregation |
| Schema changes | ALTER TABLE for new attributes | New rows, no schema change |
| Sparsity | Many NULLs if attributes are sparse | No NULL waste, but more rows |
| Query clarity | `SELECT temp, humidity FROM readings` | `WHERE metric IN ('temp', 'humidity')` then pivot |

**Wide**: when attributes are known and stable. Star schema dimensions are intentionally wide.

**Narrow**: when attributes vary per entity or change frequently. Time-series data often uses narrow format. Taken to the extreme, narrow tables become EAV (an anti-pattern, see below).

## JSON/JSONB Columns

### When to use

- Varying/sparse attributes per entity (product catalogs where each category has different fields)
- User preferences/settings
- Event payloads/audit logs with varying structure
- API response caching
- Prototyping when schema is not yet settled

### When NOT to use

- Fields frequently filtered, joined, sorted, or used in constraints: use relational columns
- Data with fixed, well-known structure: relational columns are simpler and more efficient
- Fields used in JOINs or foreign key relationships

### Best practice: hybrid approach

Model stable, frequently queried attributes as columns. Add a JSONB column for the variable/rare attributes.

```sql
CREATE TABLE products (
    product_id  INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL,
    price       NUMERIC(10,2) NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now(),
    attributes  JSONB DEFAULT '{}'  -- variable attributes per category
);
```

### Indexing JSONB

**GIN index**: the primary index type for JSONB. Two operator classes:

- `jsonb_ops` (default): supports `@>`, `?`, `?|`, `?&`. Larger indexes but more versatile.
- `jsonb_path_ops`: only supports `@>` containment. Smaller and faster for containment queries.

```sql
CREATE INDEX idx_products_attrs ON products USING GIN (attributes);
CREATE INDEX idx_products_attrs_path ON products USING GIN (attributes jsonb_path_ops);
```

**Critical**: GIN indexes accelerate containment operators (`@>`, `?`), NOT extraction operators (`->>`, `->`).

```sql
-- BAD: GIN index not used
SELECT * FROM products WHERE attributes->>'color' = 'red';

-- GOOD: GIN index used
SELECT * FROM products WHERE attributes @> '{"color": "red"}';
```

**Expression indexes** for specific hot paths:

```sql
CREATE INDEX idx_products_color ON products ((attributes->>'color'));
```

## Data Types

### Text

PostgreSQL stores TEXT, VARCHAR, and VARCHAR(n) identically. No performance difference. Prefer TEXT for most string columns. Use VARCHAR(n) only when the database should enforce a maximum length as a business rule (e.g., ISO country codes, fixed-format identifiers).

### Numeric

| Type | Use for | Avoid for |
|------|---------|-----------|
| INTEGER / BIGINT | Counts, IDs, whole numbers | Fractional values |
| NUMERIC(p,s) | Money, financial calculations, anything where rounding errors matter | High-volume scientific computation (slower than float) |
| FLOAT / DOUBLE PRECISION | Scientific measurements, approximate values | Money, exact comparisons (`0.1 + 0.2 != 0.3`) |

### Timestamps

Prefer TIMESTAMPTZ for points-in-time (events, `created_at`, `updated_at`, audit logs, expiration times). PostgreSQL stores TIMESTAMPTZ as UTC internally and converts on display, which avoids bugs when servers change timezone or data crosses timezone boundaries.

Use TIMESTAMP (without time zone) only for true local wall-clock datetimes that are not instants, such as a recurring local schedule or a store's local opening/closing time. Use DATE when you genuinely only need the date (birthdays, business days). Use INTERVAL for durations.

### Booleans

Use BOOLEAN, not integer flags (0/1) or char flags ('Y'/'N'). Boolean columns are self-documenting and type-safe.

### Enums vs CHECK vs lookup tables

| Approach | Pros | Cons | Use when |
|----------|------|------|----------|
| PostgreSQL ENUM | Compact storage, type-safe | Adding values is easy, removing/reordering is not; requires migration | Truly stable, small sets (status types, priority levels) |
| CHECK constraint | Simple, no custom type | Values not easily discoverable via introspection | Simple validation on a single column |
| Lookup/reference table | Most flexible, can add metadata (display name, sort order, is_active), queryable, FK-enforceable | Extra join | Sets that might grow or need metadata |

## Primary Keys

### Surrogate vs natural keys

Use surrogate keys (system-generated, no business meaning) as primary keys. Enforce natural/business keys as `UNIQUE NOT NULL` constraints.

```sql
CREATE TABLE customers (
    id    INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,  -- natural key enforced as unique
    name  TEXT NOT NULL
);
```

Surrogate keys are immune to business logic changes, smaller for joins, and simpler for FK references.

### UUID vs integer

| Aspect | Integer (IDENTITY) | UUID |
|--------|--------------------|------|
| Size | 4-8 bytes | 16 bytes |
| Index performance | Better (sequential, cache-friendly) | Worse (random, more page splits) |
| Distributed generation | Requires sequence coordination | Globally unique, no coordination |
| External exposure | Leaks row count/order | Opaque, no information leakage |

Default to `GENERATED ALWAYS AS IDENTITY` for single-server systems. Use UUIDs when generating IDs across multiple services or exposing IDs externally. Prefer UUIDv7 (time-sorted) over UUIDv4 (random) to reduce index fragmentation.

### Composite keys

Appropriate for join/association tables. Even there, consider a surrogate PK with a unique constraint on the composite, especially if the join table will itself be referenced by other tables.

## Constraints

### NOT NULL

Default to NOT NULL on every column unless you have a specific reason to allow NULL. NULL means "unknown" or "not applicable," not "empty string" or "zero." When the absence of a value has a sensible default, use DEFAULT instead of allowing NULL.

### CHECK

Validate data at the database level. Prefer CHECK over application-only validation: the database is the last line of defense.

```sql
CREATE TABLE orders (
    id          INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    quantity    INT NOT NULL CHECK (quantity > 0),
    unit_price  NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
    status      TEXT NOT NULL CHECK (status IN ('pending', 'shipped', 'delivered', 'cancelled')),
    start_date  DATE NOT NULL,
    end_date    DATE NOT NULL,
    CHECK (end_date > start_date)
);
```

### EXCLUDE

Prevent overlapping ranges (requires btree_gist extension). Essential for scheduling, reservations, temporal data.

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE room_bookings (
    room_id   INT NOT NULL,
    booked_at TSTZRANGE NOT NULL,
    EXCLUDE USING GIST (room_id WITH =, booked_at WITH &&)
);
```

### DEFAULT

Use for timestamps (`DEFAULT now()`), JSONB (`DEFAULT '{}'`), booleans (`DEFAULT TRUE`), counters (`DEFAULT 0`). Avoid defaults that hide bugs (e.g., defaulting a required business field to empty string).

### Foreign key cascades

| Behavior | ON DELETE | ON UPDATE | Use when |
|----------|-----------|-----------|----------|
| RESTRICT | Prevent deletion if children exist | Prevent PK change if children exist | Default. Safest. |
| CASCADE | Delete children with parent | Update children's FK when parent PK changes | True ownership (delete user -> delete sessions) |
| SET NULL | Set FK to NULL on parent deletion | Set FK to NULL on parent PK change | Optional relationships where history should survive |
| NO ACTION | Like RESTRICT but checked at transaction end | Like RESTRICT but deferred | Deferred constraint checking needed |

**Rule**: default to RESTRICT. Use CASCADE only for true parent-child ownership where orphaned children have no meaning. Document every CASCADE with a COMMENT explaining why.

## Indexing Strategy

### When to add

- Columns in `WHERE`, `JOIN`, and `ORDER BY` that are queried frequently
- Foreign key columns (PostgreSQL does NOT auto-index FKs)
- Do NOT index every column: each extra index slows writes and increases vacuum work

### Index types

**Composite indexes**: column order matters. PostgreSQL uses the index only if the query filters on a leading prefix.

```sql
-- Useful for: WHERE status = 'active' AND created_at > ...
-- Also for: WHERE status = 'active' (leading column alone)
-- NOT for: WHERE created_at > ... (skips leading column)
CREATE INDEX idx_orders_status_created ON orders (status, created_at);
```

**Unique indexes**: enforce uniqueness as a constraint. Use `CREATE UNIQUE INDEX` for unique business rules that are not the primary key. Prefer unique indexes over UNIQUE table constraints when you also need to filter (partial unique index) or include extra columns.

```sql
-- Enforce one active subscription per customer
CREATE UNIQUE INDEX uq_subscriptions_active
    ON subscriptions (customer_id) WHERE is_active = TRUE;
```

**Partial indexes**: index only rows matching a condition. Smaller and faster.

```sql
CREATE INDEX idx_orders_active ON orders (created_at) WHERE status = 'active';
```

**Covering indexes (INCLUDE)**: add non-indexed columns for index-only scans.

```sql
CREATE INDEX idx_users_username ON users (username) INCLUDE (email);
```

### Index maintenance

Monitor with `pg_stat_user_indexes` (`idx_scan` counts). Drop indexes where `idx_scan = 0` for extended periods. Use `REINDEX CONCURRENTLY` for bloated indexes. Tune autovacuum on high-churn tables.

## Partitioning

Partitioning adds complexity (partition key constraints on all unique indexes, query planning overhead, DDL management per partition). Use it sparingly: only when analytical queries on a large table are demonstrably slow and the bottleneck is scan size, not missing indexes or poor query structure. Fix indexes and query plans first. Partition only after profiling proves the table is too large for those fixes to help.

### When to partition

- Tables with hundreds of millions of rows where queries consistently filter on the partition key and performance is still poor after proper indexing
- Time-series data where old data must be dropped or archived by time range (partition detach is far cheaper than DELETE)
- Multi-tenant data at scale where tenant-level isolation improves both performance and maintenance

Do not partition small or medium tables. The overhead outweighs the benefit when the entire table fits comfortably in memory or when proper indexes already make queries fast.

### Partition types

**Range** (most common): partition by date ranges, numeric ranges. Ideal for time-series.

```sql
CREATE TABLE events (
    id         BIGINT GENERATED ALWAYS AS IDENTITY,
    occurred_at TIMESTAMPTZ NOT NULL,
    payload    JSONB NOT NULL
) PARTITION BY RANGE (occurred_at);

CREATE TABLE events_2025_q1 PARTITION OF events
    FOR VALUES FROM ('2025-01-01') TO ('2025-04-01');
CREATE TABLE events_2025_q2 PARTITION OF events
    FOR VALUES FROM ('2025-04-01') TO ('2025-07-01');
```

**List**: partition by discrete values. Good for multi-tenant or category-based splits.

```sql
CREATE TABLE metrics (
    tenant_id  INT NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    value      NUMERIC NOT NULL
) PARTITION BY LIST (tenant_id);

CREATE TABLE metrics_tenant_1 PARTITION OF metrics FOR VALUES IN (1);
CREATE TABLE metrics_tenant_2 PARTITION OF metrics FOR VALUES IN (2);
```

**Hash**: distribute rows evenly across N partitions. Use when no natural range or list key exists but you want parallel scans or even I/O spread.

### Lifecycle management

Detach and drop old partitions instead of running DELETE statements. DELETE on large tables generates enormous WAL, holds locks, and bloats the table until vacuum runs. Detaching is near-instant.

```sql
ALTER TABLE events DETACH PARTITION events_2024_q1;
DROP TABLE events_2024_q1;
```

### Partition key in indexes

Every unique index (including the primary key) on a partitioned table must include the partition key. PostgreSQL enforces this because it cannot guarantee global uniqueness across partitions otherwise.

```sql
-- This fails on a partitioned table:
-- PRIMARY KEY (id)
-- This works:
PRIMARY KEY (id, occurred_at)
```

## Materialization Strategy

When queries need precomputed aggregations, joins, or denormalized snapshots, you have three options: materialized views, pipeline-built tables, or triggers/procedures. They differ fundamentally in how they handle incremental updates, and this difference dominates at scale.

### Materialized views: the scaling problem

PostgreSQL `REFRESH MATERIALIZED VIEW` re-executes the entire defining query from scratch. If 500 rows changed out of 100 million, Postgres still scans all 100 million. Refresh time grows linearly with total data size, regardless of change rate.

**Locking compounds the problem.** A standard refresh acquires an exclusive lock, blocking all reads until it completes. `REFRESH CONCURRENTLY` avoids the lock but requires a unique index, runs slower, and generates dead tuples that need vacuuming.

**When materialized views are appropriate:**

- Small datasets (under ~1M rows) where full refresh completes in seconds
- Read-heavy, rarely-changing reference data
- Prototyping, before the refresh cost matters

**When they break down:**

- Large or growing datasets where refresh time exceeds the refresh cadence
- High-frequency updates where concurrent refresh overhead and dead tuple accumulation cause cascading performance issues
- Multiple dependent materialized views, where one refresh blocks the next

### Prefer pipeline-built tables

The scalable alternative: use data pipelines (Airflow, Prefect, dbt, custom Python) to transform data and write results into regular tables. This unlocks incremental materialization, where you process only the diff rather than recomputing everything.

```sql
-- Pipeline writes only new/changed rows via upsert
INSERT INTO agg_daily_sales (date, product_id, total_qty, total_amount)
SELECT
    date_trunc('day', sold_at)::date,
    product_id,
    sum(quantity),
    sum(amount)
FROM fact_sales
WHERE sold_at >= %(watermark)s  -- only rows since last run
GROUP BY 1, 2
ON CONFLICT (date, product_id)
DO UPDATE SET
    total_qty    = EXCLUDED.total_qty,
    total_amount = EXCLUDED.total_amount;
```

**Advantages over materialized views:**

| Aspect | Materialized view | Pipeline-built table |
|--------|-------------------|----------------------|
| Refresh cost | O(total data) always | O(changed data) with incremental |
| Locking | Exclusive lock or concurrent overhead | Controlled by pipeline (upsert, swap) |
| Indexing | Standard indexes, some restrictions | Full DDL freedom (partitioning, FKs, partial indexes) |
| Observability | Opaque database operation | Pipeline logs, row counts, duration, alerts |
| Testability | Must hit the database | Transform logic testable in isolation |
| Failure handling | Refresh fails or succeeds atomically | Granular retry, partial progress, dead-letter patterns |

**Incremental patterns:**

- **Watermark append**: process rows with timestamps newer than the last run. Simple but misses late-arriving data.
- **Watermark with lookback**: subtract N intervals from the high watermark to catch late arrivals within a window.
- **Upsert on natural key**: `INSERT ... ON CONFLICT DO UPDATE`. Handles mutable source data.
- **Swap**: write to a staging table, then `ALTER TABLE RENAME` in a transaction. Zero-downtime full rebuilds when needed.
- **Periodic full refresh**: schedule weekly/monthly full rebuilds during off-peak to reset accumulated drift from incremental runs.

### Avoid triggers and stored procedures for materialization

Do not use SQL triggers or stored procedures as the primary vehicle for materializing derived data. They create hidden coupling (a developer inserting a row has no idea a cascade of side-effects fires), are difficult to test (requires integration tests against a live database), live as database state rather than version-controlled code, and scale poorly (database-tier compute is expensive and hard to scale horizontally).

**The worst pattern:** triggers that auto-refresh materialized views on insert/update. Each row-level change triggers a full MV refresh: inserting 1000 rows means 1000 full refreshes, rapid dead tuple accumulation, heavy vacuum pressure, and insert blocking.

**Valid uses for triggers:** simple audit trails (`created_at`/`updated_at` timestamps), enforcing invariants that cannot be expressed as CHECK constraints. Keep them minimal and side-effect-free.

**Rule of thumb:** if the logic involves aggregation, joins, or anything resembling a transformation, it belongs in a Python pipeline, not a trigger or stored procedure.

## Naming Conventions and Documentation

- **Table names**: pick singular or plural, be consistent across the entire database
- **Column names**: `snake_case` everywhere (PostgreSQL folds unquoted identifiers to lowercase)
- **Booleans**: `is_active`, `has_shipped`, `can_edit`
- **Foreign keys**: `<referenced_table_singular>_id` (e.g., `customer_id`)
- **Timestamps**: `created_at`, `updated_at`, `deleted_at`
- **Indexes**: `idx_<table>_<columns>`
- **Unique constraints**: `uq_<table>_<columns>`
- Avoid abbreviations unless universally understood (`id`, `url`, `sku` are fine; `cust_addr` is not)
- Never prefix with `tbl_` or `col_`

### SQL comments (COMMENT ON)

Document schemas, tables, and columns with `COMMENT ON`. These comments are stored in the database catalog, visible via `\d+` in psql, queryable from `pg_description`, and available to any tool that reads the catalog (ORMs, documentation generators, data catalogs). They are the single source of truth for what each object means.

```sql
COMMENT ON TABLE fact_sales IS 'One row per sale line item. Grain: one product sold in one transaction.';
COMMENT ON COLUMN fact_sales.total_amount IS 'quantity * unit_price after discount. Additive across all dimensions.';
COMMENT ON COLUMN dim_customer.customer_id IS 'Natural business key. Not unique in SCD Type 2: use customer_key for joins.';
COMMENT ON INDEX idx_orders_status_created IS 'Covers active order queries filtered by status + date range.';
```

**What to document:**

- Every table: its grain (what one row represents), its role (fact, dimension, staging, aggregate)
- Columns where the name alone is ambiguous: units, business rules, whether it is additive, FK semantics
- Non-obvious indexes: why they exist, which query patterns they serve
- CASCADE foreign keys: why deletion cascades rather than restricts
- Constraints with non-trivial logic: what business rule the CHECK or EXCLUDE enforces

**When to write comments:** at table creation time, not retroactively. Treat `COMMENT ON` as part of the DDL, not optional documentation.

## Anti-Patterns

### EAV (Entity-Attribute-Value)

Stores data as (entity_id, attribute_name, attribute_value) rows. All values become strings (no type safety), queries require self-joins or pivots to reconstruct entities, no FK constraints on values. PostgreSQL JSONB outperforms EAV by orders of magnitude and provides better querying ergonomics.

**Fix**: use the hybrid JSONB approach (stable columns + JSONB for variable attributes).

### Polymorphic associations

A single FK column plus a "type" discriminator referencing different tables depending on the type. Cannot enforce referential integrity with foreign keys.

```sql
-- Anti-pattern: no FK constraint possible
CREATE TABLE comments (
    id               INT PRIMARY KEY,
    body             TEXT,
    commentable_id   INT,
    commentable_type TEXT  -- 'Post', 'Article', 'Photo'
);
```

**Fix**: separate association tables per type, or a shared table with multiple nullable FKs and a CHECK constraint ensuring exactly one is set:

```sql
CREATE TABLE comments (
    id       INT PRIMARY KEY,
    body     TEXT,
    post_id  INT REFERENCES posts(id),
    photo_id INT REFERENCES photos(id),
    CHECK (num_nonnulls(post_id, photo_id) = 1)
);
```

### God table / mega-table

A single table with hundreds of columns covering unrelated concerns. Massive NULL waste, ineffective indexes, painful ALTER TABLE. Tables should typically stay under 20-30 columns. Decompose into focused tables with single responsibilities.

### Over-normalization

Splitting into so many tables that every query requires 5+ joins. Creating lookup tables with 2-3 static rows that never change, when a CHECK constraint or enum would suffice.
