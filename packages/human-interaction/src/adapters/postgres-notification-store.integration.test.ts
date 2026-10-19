import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll } from "vitest";
import type { ApprovalEvent } from "../approvals/approval-store.js";
import { describeApprovalStore } from "../approvals/approval-store.suite.js";
import { describeNotificationStore } from "../notification-store.suite.js";
import { createPostgresApprovalStore } from "./postgres-approval-store.js";
import { createPostgresNotificationStore, migrateHumanInteractionStore } from "./postgres-notification-store.js";

/* Runs the shared notification store suite against a throwaway Postgres container. */

const run = promisify(execFile);
const docker = async (...args: string[]) => (await run("docker", args)).stdout.trim();

const image = "postgres:18.6-alpine"; // as in deploy/compose.yaml
let container: string;
let pool: pg.Pool;

beforeAll(async () => {
  container = await docker(
    "run", "-d", "--rm", "--label", "dev.tendworks.test=human-interaction-store",
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
  await migrateHumanInteractionStore(pool);
  await migrateHumanInteractionStore(pool); // idempotent
});

afterAll(async () => {
  await pool?.end();
  if (container) await docker("rm", "-f", "-v", container);
});

describeNotificationStore("Postgres", () => createPostgresNotificationStore(pool));

// Approval events go to a table of the test inside the store's transaction, so only
// events of committed writes show up.
describeApprovalStore("Postgres", async () => {
  await pool.query("create table if not exists approval_test_events (position bigserial primary key, event jsonb not null)");
  const store = createPostgresApprovalStore({
    pool,
    publisher: { publish: async (tx, event) => void (await tx.query("insert into approval_test_events (event) values ($1)", [JSON.stringify(event)])) },
  });
  return {
    store,
    published: async () => (await pool.query<{ event: ApprovalEvent }>("select event from approval_test_events order by position")).rows.map((row) => row.event),
  };
});
