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
 *     (see `scripts/generate-database-reference.ts`).
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

/** Reusable optional-number fields used across adapters. The schema only
 *  enforces type (number); the loader applies range clamping for
 *  `max_rows` and discards out-of-range `query_timeout` / `port` so that a
 *  config with a typo (e.g. `port = 0`) loads with a warning rather than
 *  failing the whole entry. Range expectations are documented in the
 *  per-adapter reference. */
const QueryTimeout = Type.Optional(Type.Number());
const MaxRows = Type.Optional(Type.Number());
const Port = Type.Optional(Type.Number());

const PostgresSchema = Type.Object({
  type: Type.Literal('postgres'),
  database: Type.String(),
  host: Type.Optional(Type.String()),
  port: Port,
  user: Type.Optional(Type.String()),
  password: Type.Optional(Type.String()),
  socket: Type.Optional(Type.String()),
  ssl: Type.Optional(Type.Boolean()),
  query_timeout: QueryTimeout,
  max_rows: MaxRows,
});

const MysqlSchema = Type.Object({
  type: Type.Literal('mysql'),
  database: Type.String(),
  host: Type.Optional(Type.String()),
  port: Port,
  user: Type.Optional(Type.String()),
  password: Type.Optional(Type.String()),
  socket: Type.Optional(Type.String()),
  ssl: Type.Optional(Type.Boolean()),
  query_timeout: QueryTimeout,
  max_rows: MaxRows,
});

/** mssql requires `user` and `password` because tedious has no native
 *  credential fallback and System2 doesn't currently support domain auth.
 *  `host` is optional: the adapter defaults it to `localhost`, mirroring
 *  the typical local-development case. */
const MssqlSchema = Type.Object({
  type: Type.Literal('mssql'),
  database: Type.String(),
  user: Type.String(),
  password: Type.String(),
  host: Type.Optional(Type.String()),
  port: Port,
  ssl: Type.Optional(Type.Boolean()),
  query_timeout: QueryTimeout,
  max_rows: MaxRows,
});

const ClickhouseSchema = Type.Object({
  type: Type.Literal('clickhouse'),
  database: Type.String(),
  host: Type.Optional(Type.String()),
  port: Port,
  user: Type.Optional(Type.String()),
  password: Type.Optional(Type.String()),
  ssl: Type.Optional(Type.Boolean()),
  query_timeout: QueryTimeout,
  max_rows: MaxRows,
});

/** Snowflake enforces "at least one of password or credentials_file" via a
 *  union of two variants: one where `password` is required, one where
 *  `credentials_file` is required. Either field can be set in either variant
 *  (a credentials_file can coexist with a password without being forbidden,
 *  matching what snowflake-sdk accepts). The loader special-cases the union-
 *  rejection error so users see a useful "missing one of" message instead of
 *  the default "no variant matched". */
const SnowflakeWithPassword = Type.Object({
  type: Type.Literal('snowflake'),
  account: Type.String(),
  user: Type.String(),
  password: Type.String(),
  database: Type.Optional(Type.String()),
  warehouse: Type.Optional(Type.String()),
  role: Type.Optional(Type.String()),
  schema: Type.Optional(Type.String()),
  credentials_file: Type.Optional(Type.String()),
  query_timeout: QueryTimeout,
  max_rows: MaxRows,
});

const SnowflakeWithKeyPair = Type.Object({
  type: Type.Literal('snowflake'),
  account: Type.String(),
  user: Type.String(),
  credentials_file: Type.String(),
  password: Type.Optional(Type.String()),
  database: Type.Optional(Type.String()),
  warehouse: Type.Optional(Type.String()),
  role: Type.Optional(Type.String()),
  schema: Type.Optional(Type.String()),
  query_timeout: QueryTimeout,
  max_rows: MaxRows,
});

const SnowflakeSchema = Type.Union([SnowflakeWithPassword, SnowflakeWithKeyPair]);

const BigQuerySchema = Type.Object({
  type: Type.Literal('bigquery'),
  project: Type.String(),
  database: Type.String(),
  credentials_file: Type.Optional(Type.String()),
  query_timeout: QueryTimeout,
  max_rows: MaxRows,
});

const SqliteSchema = Type.Object({
  type: Type.Literal('sqlite'),
  database: Type.String(),
  max_rows: MaxRows,
});

const DuckDbSchema = Type.Object({
  type: Type.Literal('duckdb'),
  database: Type.String(),
  query_timeout: QueryTimeout,
  max_rows: MaxRows,
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
    'Either `password` (basic auth) or `credentials_file` pointing at a private key (key-pair auth) must be set. `SNOWFLAKE_PASSWORD` env var is also honoured by the SDK if neither is in the TOML.',
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
