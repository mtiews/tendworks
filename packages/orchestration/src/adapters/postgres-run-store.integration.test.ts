import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll } from "vitest";
import { describeRunStore } from "../runs/run-store.suite.js";
import { createPostgresOutbox, createPostgresRunStore, migrateOrchestrationStore } from "./postgres-run-store.js";

/* Runs the shared run store suite against a throwaway Postgres container. */

const run = promisify(execFile);
const docker = async (...args: string[]) => (await run("docker", args)).stdout.trim();

const image = "postgres:18.6-alpine"; // as in deploy/compose.yaml
let container: string;
let pool: pg.Pool;

beforeAll(async () => {
  container = await docker(
    "run", "-d", "--rm", "--label", "dev.tendworks.test=orchestration-run-store",
    "-e", "POSTGRES_PASSWORD=test", "-p", "127.0.0.1::5432", image,
  );
  const address = (await docker("port", container, "5432/tcp")).split("\n")[0]!;
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
