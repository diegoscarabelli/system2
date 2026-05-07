/**
 * Database Connection Schema
 *
 * TypeBox schemas for `[databases.<name>]` blocks in `~/.system2/config.toml`.
 * Single source of truth for:
 *
 *   - Runtime validation in the loader (`convertTomlDatabases` in
 *     `src/cli/utils/config.ts`).
 *   - The `DatabaseConnectionConfig` static type that adapters consume.
 *   - The per-adapter reference auto-generated into the `editing-config-toml`
 *     agent skill and the database table in `docs/configuration.md`
 *     (see `src/cli/utils/databases-reference-generator.ts`, runnable via
 *     `pnpm generate:db-reference`).
 *
 * Each adapter is its own sub-schema. They share no composed base — the goal
 * is that adding a new adapter or evolving an existing one touches only the
 * affected variant. The discriminator is the literal `type` field, which
 * picks which variant applies during validation.
 *
 * For the per-adapter required/optional rationale, see
 * `docs/configuration.md#databases` (the auto-generated section) or the
 * brainstorming spec at issue #166.
 */

import { type Static, Type } from '@sinclair/typebox';

// (Numeric range constraints intentionally not in the schema. The loader
// applies range clamping for `max_rows` and discards out-of-range
// `query_timeout` / `port` so a typo'd `port = 0` doesn't reject the whole
// entry. Range expectations are surfaced via per-field `description`
// annotations and the auto-generated reference table.)

const PostgresSchema = Type.Object({
  type: Type.Literal('postgres', { description: 'Must be `"postgres"`' }),
  database: Type.String({ description: 'Database name' }),
  host: Type.Optional(Type.String({ description: 'Defaults to `localhost`' })),
  port: Type.Optional(Type.Number({ description: 'Defaults to `5432`' })),
  user: Type.Optional(Type.String({ description: 'Defaults to current OS user' })),
  password: Type.Optional(
    Type.String({ description: 'Falls back to `~/.pgpass`, `PGPASSWORD` env var' })
  ),
  socket: Type.Optional(
    Type.String({ description: 'Unix domain socket path; overrides host/port' })
  ),
  ssl: Type.Optional(Type.Boolean({ description: 'Enable SSL/TLS; defaults `false`' })),
  query_timeout: Type.Optional(Type.Number({ description: 'Seconds; defaults `30`' })),
  max_rows: Type.Optional(
    Type.Number({ description: 'Per-query row cap; defaults `10000`, max `1000000`' })
  ),
});

const MysqlSchema = Type.Object({
  type: Type.Literal('mysql', { description: 'Must be `"mysql"`' }),
  database: Type.String({ description: 'Database name' }),
  host: Type.Optional(Type.String({ description: 'Defaults to `localhost`' })),
  port: Type.Optional(Type.Number({ description: 'Defaults to `3306`' })),
  user: Type.Optional(Type.String({ description: 'Defaults to current OS user' })),
  password: Type.Optional(
    Type.String({
      description: 'Falls back to `~/.my.cnf` `[client]` section, `MYSQL_PWD` env var',
    })
  ),
  socket: Type.Optional(Type.String({ description: 'Unix domain socket path' })),
  ssl: Type.Optional(Type.Boolean({ description: 'Enable SSL/TLS; defaults `false`' })),
  query_timeout: Type.Optional(Type.Number({ description: 'Seconds; defaults `30`' })),
  max_rows: Type.Optional(
    Type.Number({ description: 'Per-query row cap; defaults `10000`, max `1000000`' })
  ),
});

/** mssql requires `user` and `password` because tedious has no native
 *  credential fallback and System2 doesn't currently support domain auth.
 *  `host` is optional: the adapter defaults it to `localhost`, mirroring
 *  the typical local-development case. */
const MssqlSchema = Type.Object({
  type: Type.Literal('mssql', { description: 'Must be `"mssql"`' }),
  database: Type.String({ description: 'Database name' }),
  user: Type.String({ description: 'Required (no native fallback for tedious)' }),
  password: Type.String({ description: 'Required (no native fallback for tedious)' }),
  host: Type.Optional(Type.String({ description: 'Defaults to `localhost`' })),
  port: Type.Optional(Type.Number({ description: 'Defaults to `1433`' })),
  ssl: Type.Optional(Type.Boolean({ description: 'Controls `encrypt`; defaults `false`' })),
  query_timeout: Type.Optional(Type.Number({ description: 'Seconds; defaults `30`' })),
  max_rows: Type.Optional(
    Type.Number({ description: 'Per-query row cap; defaults `10000`, max `1000000`' })
  ),
});

const ClickhouseSchema = Type.Object({
  type: Type.Literal('clickhouse', { description: 'Must be `"clickhouse"`' }),
  database: Type.String({ description: 'Database name' }),
  host: Type.Optional(Type.String({ description: 'Defaults to `localhost`' })),
  port: Type.Optional(Type.Number({ description: 'Defaults to `8123` (HTTP) or `8443` (HTTPS)' })),
  user: Type.Optional(Type.String({ description: 'Defaults to `default`' })),
  password: Type.Optional(
    Type.String({
      description: 'Defaults to empty (the `default` user typically has empty password)',
    })
  ),
  ssl: Type.Optional(Type.Boolean({ description: 'Selects `https` protocol' })),
  query_timeout: Type.Optional(Type.Number({ description: 'Seconds; defaults `30`' })),
  max_rows: Type.Optional(
    Type.Number({ description: 'Per-query row cap; defaults `10000`, max `1000000`' })
  ),
});

/** Snowflake enforces "at least one of password or credentials_file" via a
 *  union of two variants: one where `password` is required, one where
 *  `credentials_file` is required. Either field can be set in either variant
 *  (a credentials_file can coexist with a password without being forbidden,
 *  matching what snowflake-sdk accepts). The loader special-cases the union-
 *  rejection error so users see a useful "missing one of" message instead of
 *  the default "no variant matched". */
const SnowflakeWithPassword = Type.Object({
  type: Type.Literal('snowflake', { description: 'Must be `"snowflake"`' }),
  account: Type.String({ description: 'Account identifier (e.g. `xy12345.us-east-1`)' }),
  user: Type.String({ description: 'Authentication username' }),
  password: Type.String({ description: 'Basic auth password' }),
  database: Type.Optional(
    Type.String({ description: 'Default database (sessions can issue `USE database` per-query)' })
  ),
  warehouse: Type.Optional(Type.String({ description: 'Default virtual warehouse' })),
  role: Type.Optional(Type.String({ description: 'Default security role' })),
  schema: Type.Optional(Type.String({ description: 'Default schema' })),
  credentials_file: Type.Optional(
    Type.String({ description: 'Path to PEM private key (key-pair auth alternative to password)' })
  ),
  query_timeout: Type.Optional(Type.Number({ description: 'Seconds; defaults `30`' })),
  max_rows: Type.Optional(
    Type.Number({ description: 'Per-query row cap; defaults `10000`, max `1000000`' })
  ),
});

const SnowflakeWithKeyPair = Type.Object({
  type: Type.Literal('snowflake', { description: 'Must be `"snowflake"`' }),
  account: Type.String({ description: 'Account identifier (e.g. `xy12345.us-east-1`)' }),
  user: Type.String({ description: 'Authentication username' }),
  credentials_file: Type.String({
    description: 'Path to PEM private key (sets `authenticator = "SNOWFLAKE_JWT"`)',
  }),
  password: Type.Optional(Type.String({ description: 'Basic auth alternative to key-pair' })),
  database: Type.Optional(
    Type.String({ description: 'Default database (sessions can issue `USE database` per-query)' })
  ),
  warehouse: Type.Optional(Type.String({ description: 'Default virtual warehouse' })),
  role: Type.Optional(Type.String({ description: 'Default security role' })),
  schema: Type.Optional(Type.String({ description: 'Default schema' })),
  query_timeout: Type.Optional(Type.Number({ description: 'Seconds; defaults `30`' })),
  max_rows: Type.Optional(
    Type.Number({ description: 'Per-query row cap; defaults `10000`, max `1000000`' })
  ),
});

const SnowflakeSchema = Type.Union([SnowflakeWithPassword, SnowflakeWithKeyPair]);

const BigQuerySchema = Type.Object({
  type: Type.Literal('bigquery', { description: 'Must be `"bigquery"`' }),
  project: Type.String({ description: 'GCP project ID' }),
  database: Type.String({ description: 'BigQuery dataset name' }),
  credentials_file: Type.Optional(
    Type.String({
      description:
        'Path to service-account JSON. Falls back to ADC (`GOOGLE_APPLICATION_CREDENTIALS` env var or `gcloud auth application-default login`)',
    })
  ),
  query_timeout: Type.Optional(Type.Number({ description: 'Seconds; defaults `30`' })),
  max_rows: Type.Optional(
    Type.Number({ description: 'Per-query row cap; defaults `10000`, max `1000000`' })
  ),
});

const SqliteSchema = Type.Object({
  type: Type.Literal('sqlite', { description: 'Must be `"sqlite"`' }),
  database: Type.String({ description: 'Filepath to the `.db`/`.sqlite`/`.sqlite3` file' }),
  max_rows: Type.Optional(
    Type.Number({ description: 'Per-query row cap; defaults `10000`, max `1000000`' })
  ),
});

const DuckDbSchema = Type.Object({
  type: Type.Literal('duckdb', { description: 'Must be `"duckdb"`' }),
  database: Type.String({
    description: 'Filepath, or `:memory:`, or `md:<dbname>` for MotherDuck',
  }),
  query_timeout: Type.Optional(Type.Number({ description: 'Seconds; defaults `30`' })),
  max_rows: Type.Optional(
    Type.Number({ description: 'Per-query row cap; defaults `10000`, max `1000000`' })
  ),
});

/** Union of all adapter variants. Validation against this union picks the
 *  matching adapter via the `type` discriminator, then enforces that adapter's
 *  required fields. */
export const DatabaseConnectionSchema = Type.Union([
  PostgresSchema,
  MysqlSchema,
  MssqlSchema,
  ClickhouseSchema,
  SnowflakeSchema,
  BigQuerySchema,
  SqliteSchema,
  DuckDbSchema,
]);

/** Strict discriminated-union type derived from the schema. Used inside the
 *  loader (after `Value.Check` succeeds) and by the generator script. The
 *  broader `DatabaseConnectionConfig` interface in `types/config.ts` is the
 *  type the rest of the server (adapters, registry, emitter) consumes — it
 *  mirrors the union of every variant's fields, kept in sync via a compile-
 *  time guard near `convertTomlDatabases`. */
export type ValidatedDatabaseConnection = Static<typeof DatabaseConnectionSchema>;

/** Per-adapter static types. Available for narrow callers; the broad
 *  `DatabaseConnectionConfig` is what current adapters consume. */
export type PostgresConnectionConfig = Static<typeof PostgresSchema>;
export type MysqlConnectionConfig = Static<typeof MysqlSchema>;
export type MssqlConnectionConfig = Static<typeof MssqlSchema>;
export type ClickhouseConnectionConfig = Static<typeof ClickhouseSchema>;
export type SnowflakeConnectionConfig = Static<typeof SnowflakeSchema>;
export type BigQueryConnectionConfig = Static<typeof BigQuerySchema>;
export type SqliteConnectionConfig = Static<typeof SqliteSchema>;
export type DuckDbConnectionConfig = Static<typeof DuckDbSchema>;

/** Convenience: the discriminator string set, derivable from the schema but
 *  spelled out here so consumers don't have to reach into TypeBox internals. */
export const ADAPTER_TYPES = [
  'postgres',
  'mysql',
  'mssql',
  'clickhouse',
  'snowflake',
  'bigquery',
  'sqlite',
  'duckdb',
] as const;

export type AdapterType = (typeof ADAPTER_TYPES)[number];

/** Per-variant schemas keyed by adapter type. Used by the loader to produce
 *  precise validation errors: TypeBox's `Value.Errors` on a `Type.Union` only
 *  reports a generic "expected union value" at the root, so the loader looks
 *  up the variant that matches the entry's `type` discriminator and validates
 *  the entry against that single schema instead. The snowflake variant is
 *  itself a `Type.Union` of password vs key-pair auth; the loader special-
 *  cases that error path separately. */
export const ADAPTER_SCHEMAS = {
  postgres: PostgresSchema,
  mysql: MysqlSchema,
  mssql: MssqlSchema,
  clickhouse: ClickhouseSchema,
  snowflake: SnowflakeSchema,
  bigquery: BigQuerySchema,
  sqlite: SqliteSchema,
  duckdb: DuckDbSchema,
} as const;

/** Per-adapter metadata used by the doc generator. Not part of validation —
 *  these strings describe the fallback credential mechanism each adapter
 *  honours when `password` (or its equivalent) is omitted from the TOML.
 *  Keys must cover every value of `AdapterType`. */
export const ADAPTER_CREDENTIAL_FALLBACKS: Record<AdapterType, string> = {
  postgres: '`~/.pgpass`, `PGPASSWORD` env var',
  mysql: '`~/.my.cnf` `[client]` section, `MYSQL_PWD` env var',
  mssql: 'No native fallback; `password` is required.',
  clickhouse:
    'Server-side default credentials (driver defaults to user `default` with empty password).',
  snowflake:
    'Either `password` (basic auth) or `credentials_file` pointing at a private key (key-pair auth) must be set in the TOML. The schema rejects entries with neither at startup, so the snowflake-sdk `SNOWFLAKE_PASSWORD` env-var fallback is not reachable through this loader.',
  bigquery:
    'Application Default Credentials (ADC) via `gcloud auth application-default login`, or `GOOGLE_APPLICATION_CREDENTIALS` env var.',
  sqlite: 'No credentials needed (local file).',
  duckdb: 'No credentials needed (local file). For MotherDuck, set `MOTHERDUCK_TOKEN` env var.',
};

/** Per-adapter one-line purpose string for the generated reference. */
export const ADAPTER_DESCRIPTIONS: Record<AdapterType, string> = {
  postgres:
    'PostgreSQL (also works for TimescaleDB, CockroachDB, and other Postgres-wire-compatible servers).',
  mysql: 'MySQL or MariaDB.',
  mssql: 'Microsoft SQL Server via the tedious driver.',
  clickhouse: 'ClickHouse over HTTP/HTTPS.',
  snowflake:
    'Snowflake. Authenticate via `password` (basic auth) or `credentials_file` (key-pair auth).',
  bigquery: 'Google BigQuery. `database` is the BigQuery dataset name.',
  sqlite: 'Local SQLite file (read-only). `database` holds the filepath.',
  duckdb: 'Local DuckDB file. `database` holds the filepath; use `:memory:` for an in-memory DB.',
};
