---
name: sql-schema-modeling
description: Use when designing database schemas, choosing between normalization levels, modeling dimensional/star schemas, deciding on JSON columns vs relational columns, or reviewing table structures. Trigger on CREATE TABLE statements, schema design discussions, or questions about data modeling patterns.
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

Aim for 3NF as a baseline for OLTP systems. Denormalize deliberately for read-heavy workloads (analytics, reporting). Always denormalize based on measured query patterns, not guesswork. Keep normalized source tables and create denormalized views or materialized views for read paths.

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

## Naming Conventions

- **Table names**: pick singular or plural, be consistent across the entire database
- **Column names**: `snake_case` everywhere (PostgreSQL folds unquoted identifiers to lowercase)
- **Booleans**: `is_active`, `has_shipped`, `can_edit`
- **Foreign keys**: `<referenced_table_singular>_id` (e.g., `customer_id`)
- **Timestamps**: `created_at`, `updated_at`, `deleted_at`
- **Indexes**: `idx_<table>_<columns>`
- **Unique constraints**: `uq_<table>_<columns>`
- Avoid abbreviations unless universally understood (`id`, `url`, `sku` are fine; `cust_addr` is not)
- Never prefix with `tbl_` or `col_`

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
