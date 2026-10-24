import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll } from "vitest";
import { describeFiringStore } from "../firings/firing-store.suite.js";
import { createPostgresFiringStore, createPostgresOutbox, migrateTriggerGatewayStore } from "./postgres-firing-store.js";

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
