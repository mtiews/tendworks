import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeFiringStore } from "../firings/firing-store.suite.js";
import { createPostgresFiringStore, createPostgresOutbox, migrateTriggerGatewayStore, triggerGatewayMigrations } from "./postgres-firing-store.js";

/* Runs the shared firing store suite against a throwaway Postgres container. */

const run = promisify(execFile);
const docker = async (...args: string[]) => (await run("docker", args)).stdout.trim();

const image = "postgres:18.6-alpine"; // as in deploy/compose.yaml
let container: string;
let pool: pg.Pool;
let address: string;

beforeAll(async () => {
  container = await docker(
    "run", "-d", "--rm", "--label", "dev.tendworks.test=trigger-gateway-firing-store",
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
  await migrateTriggerGatewayStore(pool);
  await migrateTriggerGatewayStore(pool); // idempotent
});

afterAll(async () => {
  await pool?.end();
  if (container) await docker("rm", "-f", "-v", container);
});

describeFiringStore("Postgres", () => {
  const outbox = createPostgresOutbox(pool);
  return { store: createPostgresFiringStore({ pool, publisher: outbox }), events: () => outbox.events() };
});

it("adopts a store created before versioned migrations, with its firings", async () => {
  await pool.query("create database adopted");
  const adopted = new pg.Pool({ connectionString: `postgres://postgres:test@${address}/adopted` });
  try {
    // Before versioned migrations, the store ran today's schema (migration 1) on every start.
    await adopted.query(triggerGatewayMigrations[0]!.sql);
    const key = { binding: "ready-issues", workspace: "app", item: "acme/app#7" };
    const evaluation = { at: "2026-10-18T10:00:00.000Z", status: "succeeded" as const, startedRuns: 1 };
    const before = createPostgresFiringStore({ pool: adopted, publisher: createPostgresOutbox(adopted) });
    expect(await before.claim(key)).toBe(true);
    await before.recordEvaluation(key.binding, evaluation);

    expect(await migrateTriggerGatewayStore(adopted)).toEqual({ from: 0, to: triggerGatewayMigrations.length });
    const after = createPostgresFiringStore({ pool: adopted, publisher: createPostgresOutbox(adopted) });
    expect(await after.claim(key)).toBe(false);
    expect(await after.lastEvaluations()).toEqual(new Map([[key.binding, evaluation]]));
  } finally {
    await adopted.end();
  }
});
