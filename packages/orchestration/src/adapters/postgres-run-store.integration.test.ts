import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeRunStore } from "../runs/run-store.suite.js";
import { createPostgresOutbox, createPostgresRunStore, migrateOrchestrationStore, orchestrationMigrations } from "./postgres-run-store.js";

/* Runs the shared run store suite against a throwaway Postgres container. */

const run = promisify(execFile);
const docker = async (...args: string[]) => (await run("docker", args)).stdout.trim();

const image = "postgres:18.6-alpine"; // as in deploy/compose.yaml
let container: string;
let pool: pg.Pool;
let address: string;

beforeAll(async () => {
  container = await docker(
    "run", "-d", "--rm", "--label", "dev.tendworks.test=orchestration-run-store",
    "-e", "POSTGRES_PASSWORD=test", "-p", "127.0.0.1::5432", image,
  );
  address = (await docker("port", container, "5432/tcp")).split("\n")[0]!;
  pool = new pg.Pool({ connectionString: `postgres://postgres:test@${address}/postgres` });
  for (let attempt = 0; ; attempt++) {
    try {
      await pool.query("select 1");
      break;
    } catch (error) {
      if (attempt > 100) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  await migrateOrchestrationStore(pool);
  await migrateOrchestrationStore(pool); // idempotent
});

afterAll(async () => {
  await pool?.end();
  if (container) await docker("rm", "-f", "-v", container);
});

describeRunStore("Postgres", () => {
  const outbox = createPostgresOutbox(pool);
  return { store: createPostgresRunStore({ pool, publisher: outbox }), events: (runId) => outbox.events(runId) };
});

it("adopts a store created before versioned migrations, with its runs", async () => {
  await pool.query("create database adopted");
  const adopted = new pg.Pool({ connectionString: `postgres://postgres:test@${address}/adopted` });
  try {
    // Before versioned migrations, the store ran today's schema (migration 1) on every start.
    await adopted.query(orchestrationMigrations[0]!.sql);
    const run = {
      id: crypto.randomUUID(),
      workflow: "hello",
      status: "pending" as const,
      input: { issue: { number: 7 } },
      steps: [],
      createdAt: "2026-10-18T10:00:00.000Z",
    };
    await createPostgresRunStore({ pool: adopted, publisher: createPostgresOutbox(adopted) }).create(run);

    expect(await migrateOrchestrationStore(adopted)).toEqual({ from: 0, to: orchestrationMigrations.length });
    expect(await createPostgresRunStore({ pool: adopted }).get(run.id)).toEqual(run);
  } finally {
    await adopted.end();
  }
});
