/**
 * Versioned schema migrations for one domain's store. Each domain owns a Postgres schema,
 * passes its own ordered migrations and keeps its version in its own table
 * (`<schema>.schema_migrations`), so no domain reads another's tables.
 *
 * Kept out of the package's browser-safe entry point: it is imported as
 * `@tendworks/platform/migrations` and needs only a structural database client.
 */

/** One step of a domain's schema; versions count up from 1 without gaps. */
export interface Migration {
  version: number;
  /** Short, stable name, e.g. `add-step-cost`; appears in the version table and in errors. */
  name: string;
  /** One or more statements, run in one transaction. */
  sql: string;
}

/** The part of a pooled database connection migrations need (e.g. a `pg.PoolClient`). */
export interface MigrationConnection {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

/** Where migrations get a connection from (e.g. a `pg.Pool`). */
export interface MigrationDatabase {
  connect(): Promise<MigrationConnection>;
}

export interface DomainMigrations {
  /** The domain's Postgres schema, e.g. `orchestration`; also names the version table and the lock. */
  schema: string;
  migrations: readonly Migration[];
}

/**
 * Brings a domain's store to its latest version: under the domain's advisory lock, runs
 * every migration above the recorded version, each in its own transaction together with
 * its entry in the version table. Throws {@link MigrationError} when one fails (it is
 * rolled back) or when the store is newer than `migrations`; the caller stops the service.
 */
export async function migrate(database: MigrationDatabase, { schema, migrations }: DomainMigrations): Promise<{ from: number; to: number }> {
  // The schema is part of statements, so it must be a plain identifier.
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`schema ${JSON.stringify(schema)}: must be a lower-case identifier`);
  if (migrations.some((migration, index) => migration.version !== index + 1)) {
    throw new Error(`schema ${schema}: migrations must be numbered 1, 2, 3 … in order; found ${migrations.map((m) => m.version).join(", ")}`);
  }
  const connection = await database.connect();
  // Serialises concurrent starts (several workers, or two bundles sharing a domain such as
  // the event bus): the first migrates, the others find the store at the latest version.
  // The key is the one the stores locked before versioned migrations.
  const lock = `${schema}.migrate`;
  try {
    await connection.query("select pg_advisory_lock(hashtext($1))", [lock]);
    await connection.query(`create schema if not exists ${schema}`);
    await connection.query(
      `create table if not exists ${schema}.schema_migrations (version integer primary key, name text not null, applied_at timestamptz not null default now())`,
    );
    const from = await currentVersion(connection, schema);
    const latest = migrations.at(-1)?.version ?? 0;
    if (from > latest) {
      throw new MigrationError(schema, `the store is at version ${from}, newer than this release knows (${latest}); downgrades are not supported`);
    }
    let to = from;
    for (const migration of migrations.filter((m) => m.version > from)) {
      try {
        await connection.query("begin");
        await connection.query(migration.sql);
        await connection.query(`insert into ${schema}.schema_migrations (version, name) values ($1, $2)`, [migration.version, migration.name]);
        await connection.query("commit");
      } catch (error) {
        await connection.query("rollback").catch(() => {});
        throw new MigrationError(schema, `migration ${migration.version} (${migration.name}) failed: ${error instanceof Error ? error.message : String(error)}`, {
          version: migration.version,
          migration: migration.name,
          cause: error,
        });
      }
      to = migration.version;
    }
    return { from, to };
  } finally {
    await connection.query("select pg_advisory_unlock(hashtext($1))", [lock]).catch(() => {});
    connection.release();
  }
}

async function currentVersion(connection: MigrationConnection, schema: string): Promise<number> {
  const { rows } = await connection.query(`select coalesce(max(version), 0) as version from ${schema}.schema_migrations`);
  return Number((rows[0] as { version: number | string }).version);
}

/**
 * A domain's store could not be brought to the version this release needs; the failing
 * migration was rolled back, so the store stays at the version before it.
 */
export class MigrationError extends Error {
  /** The migration that failed; absent when none ran (e.g. the store is newer than the release). */
  readonly version: number | undefined;
  readonly migration: string | undefined;

  constructor(
    readonly schema: string,
    problem: string,
    { version, migration, cause }: { version?: number; migration?: string; cause?: unknown } = {},
  ) {
    super(`schema ${schema}: ${problem}`, cause === undefined ? undefined : { cause });
    this.name = "MigrationError";
    this.version = version;
    this.migration = migration;
  }

  /** The component a stopped bundle reports in its health (and so in `/status`), e.g. `orchestration-schema`. */
  get component(): string {
    return `${this.schema.replaceAll("_", "-")}-schema`;
  }
}
