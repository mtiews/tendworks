import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate, MigrationError, type Migration } from "./migrations.js";

/* Runs the migration module against a throwaway Postgres container; every test owns a schema. */

const run = promisify(execFile);
const docker = async (...args: string[]) => (await run("docker", args)).stdout.trim();

const image = "postgres:18.6-alpine"; // as in deploy/compose.yaml
let container: string;
let pool: pg.Pool;

beforeAll(async () => {
  container = await docker(
    "run", "-d", "--rm", "--label", "dev.tendworks.test=platform-migrations",
    "-e", "POSTGRES_PASSWORD=test", "-p", "127.0.0.1::5432", image,
  );
  const address = (await docker("port", container, "5432/tcp")).split("\n")[0]!;
  pool = new pg.Pool({ connectionString: `postgres://postgres:test@${address}/postgres`, max: 20 });
  for (let attempt = 0; ; attempt++) {
    try {
      await pool.query("select 1");
      break;
    } catch (error) {
      if (attempt > 100) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
});

afterAll(async () => {
  await pool?.end();
  if (container) await docker("rm", "-f", "-v", container);
});

let schemas = 0;
const newSchema = () => `migration_test_${++schemas}`;

/** Migration 1 as today's stores create it: idempotent `if not exists` statements. */
const initial = (schema: string): Migration => ({
  version: 1,
  name: "initial",
  sql: `
    create schema if not exists ${schema};
    create table if not exists ${schema}.notes (id text primary key, body text not null);
  `,
});
const addAuthor = (schema: string): Migration => ({
  version: 2,
  name: "add-author",
  sql: `alter table ${schema}.notes add column author text not null default 'unknown';`,
});

const notes = async (schema: string) => (await pool.query<Record<string, string>>(`select * from ${schema}.notes order by id`)).rows;

it("brings a fresh store to the latest version", async () => {
  const schema = newSchema();

  const result = await migrate(pool, { schema, migrations: [initial(schema), addAuthor(schema)] });

  expect(result).toEqual({ from: 0, to: 2 });
  await pool.query(`insert into ${schema}.notes (id, body, author) values ('a', 'hello', 'marcel')`);
  expect(await notes(schema)).toEqual([{ id: "a", body: "hello", author: "marcel" }]);
});

it("upgrades a store at an older version and keeps its data", async () => {
  const schema = newSchema();
  await migrate(pool, { schema, migrations: [initial(schema)] });
  await pool.query(`insert into ${schema}.notes (id, body) values ('a', 'kept')`);

  const result = await migrate(pool, { schema, migrations: [initial(schema), addAuthor(schema)] });

  expect(result).toEqual({ from: 1, to: 2 });
  expect(await notes(schema)).toEqual([{ id: "a", body: "kept", author: "unknown" }]);
});

it("leaves a store at the latest version as it is", async () => {
  const schema = newSchema();
  await migrate(pool, { schema, migrations: [initial(schema), addAuthor(schema)] });

  expect(await migrate(pool, { schema, migrations: [initial(schema), addAuthor(schema)] })).toEqual({ from: 2, to: 2 });
});

it("adopts a store created without versions, with its data, through an idempotent migration 1", async () => {
  const schema = newSchema();
  // What stores looked like before versioned migrations: tables and data, no version table.
  await pool.query(initial(schema).sql);
  await pool.query(`insert into ${schema}.notes (id, body) values ('a', 'from before')`);

  const result = await migrate(pool, { schema, migrations: [initial(schema), addAuthor(schema)] });

  expect(result).toEqual({ from: 0, to: 2 });
  expect(await notes(schema)).toEqual([{ id: "a", body: "from before", author: "unknown" }]);
});

it("rolls a failing migration back, keeps the previous version and reports which one failed", async () => {
  const schema = newSchema();
  await migrate(pool, { schema, migrations: [initial(schema)] });
  await pool.query(`insert into ${schema}.notes (id, body) values ('a', 'kept')`);
  const broken: Migration = {
    version: 2,
    name: "half-done",
    // The first statement succeeds; the second fails, so the first must not stay.
    sql: `alter table ${schema}.notes add column author text; alter table ${schema}.missing add column x text;`,
  };

  const failure = await migrate(pool, { schema, migrations: [initial(schema), broken] }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(MigrationError);
  expect(failure).toMatchObject({ schema, version: 2, migration: "half-done" });
  expect((failure as Error).message).toMatch(new RegExp(`^schema ${schema}: migration 2 \\(half-done\\) failed: .*missing`));
  expect(await notes(schema)).toEqual([{ id: "a", body: "kept" }]);
  // The next start tries again from the version before.
  expect(await migrate(pool, { schema, migrations: [initial(schema), addAuthor(schema)] })).toEqual({ from: 1, to: 2 });
});

it("migrates once when several services start at the same time", async () => {
  const schema = newSchema();
  // Not idempotent: running it twice would fail or count twice.
  const counted: Migration = {
    version: 2,
    name: "counted",
    sql: `create table ${schema}.applied (at timestamptz not null default now()); insert into ${schema}.applied default values;`,
  };

  const results = await Promise.all(Array.from({ length: 8 }, () => migrate(pool, { schema, migrations: [initial(schema), counted] })));

  expect(results.filter((result) => result.from === 0)).toEqual([{ from: 0, to: 2 }]);
  expect(results.filter((result) => result.from === 2)).toHaveLength(7);
  expect((await pool.query(`select count(*)::int as n from ${schema}.applied`)).rows).toEqual([{ n: 1 }]);
});

it("refuses a store newer than the migrations it knows, since downgrades are not supported", async () => {
  const schema = newSchema();
  await migrate(pool, { schema, migrations: [initial(schema), addAuthor(schema)] });

  const failure = await migrate(pool, { schema, migrations: [initial(schema)] }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(MigrationError);
  expect((failure as Error).message).toBe(`schema ${schema}: the store is at version 2, newer than this release knows (1); downgrades are not supported`);
});
