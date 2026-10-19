import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeEventBus } from "../event-bus.suite.js";
import { createPostgresEventBus, migrateEventBus, type SqlTransaction } from "./postgres-event-bus.js";

/* Runs the shared event bus suite against a throwaway Postgres container. */

const run = promisify(execFile);
const docker = async (...args: string[]) => (await run("docker", args)).stdout.trim();

const image = "postgres:18.6-alpine"; // as in deploy/compose.yaml
let container: string;
let pool: pg.Pool;

beforeAll(async () => {
  container = await docker(
    "run", "-d", "--rm", "--label", "dev.tendworks.test=event-bus",
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
  await migrateEventBus(pool);
  await migrateEventBus(pool); // idempotent
});

afterAll(async () => {
  await pool?.end();
  if (container) await docker("rm", "-f", "-v", container);
});

async function transaction(work: (tx: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await work(client);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// A long safety poll proves that LISTEN/NOTIFY wakes the subscribers.
const busOptions = () => ({ pool, pollIntervalMs: 60_000, retryDelayMs: 10 });

describeEventBus<SqlTransaction>("Postgres", () => ({
  bus: createPostgresEventBus(busOptions()),
  transaction,
  restart: () => createPostgresEventBus(busOptions()),
}));

it("does not lose an event whose transaction commits after a later one (no gaps)", async () => {
  const bus = createPostgresEventBus(busOptions());
  const type = `dev.tendworks.test.${crypto.randomUUID()}`;
  const event = (n: number) => ({ id: `${type}:${n}`, source: "/tendworks/test", type, data: { n } });
  const received: number[] = [];
  bus.subscribe<ReturnType<typeof event>>(`sub-${crypto.randomUUID()}`, async (e) => void received.push(e.data.n), { types: [type] });

  const slow = await pool.connect();
  try {
    await slow.query("begin");
    await bus.publish(slow, event(1));
    const fast = transaction((tx) => bus.publish(tx, event(2)));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await slow.query("commit");
    await fast;
  } finally {
    slow.release();
  }

  await vi.waitFor(() => expect(received).toEqual([1, 2]));
  await bus.close();
});

it("delivers each event once when two instances share a subscription", async () => {
  const first = createPostgresEventBus(busOptions());
  const second = createPostgresEventBus(busOptions());
  const type = `dev.tendworks.test.${crypto.randomUUID()}`;
  const subscription = `sub-${crypto.randomUUID()}`;
  const event = (n: number) => ({ id: `${type}:${n}`, source: "/tendworks/test", type, data: { n } });
  const received: number[] = [];
  for (const bus of [first, second]) {
    bus.subscribe<ReturnType<typeof event>>(subscription, async (e) => void received.push(e.data.n), { types: [type] });
  }

  for (let n = 1; n <= 10; n++) await transaction((tx) => first.publish(tx, event(n)));

  await vi.waitFor(() => expect(received).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  await Promise.all([first.close(), second.close()]);
});
