import { describe, expect, it, vi } from "vitest";
import { migrate, migrateOrStop, MigrationError, type MigrationDatabase } from "./migrations.js";

// Mistakes in a domain's own migration list are programming errors, found before the store is touched.
const untouched: MigrationDatabase = {
  connect: () => Promise.reject(new Error("the store must not be touched")),
};
const step = (version: number) => ({ version, name: `step-${version}`, sql: "select 1" });

it("refuses migrations that are not numbered 1, 2, 3 … without gaps", async () => {
  await expect(migrate(untouched, { schema: "notes", migrations: [step(1), step(3)] })).rejects.toThrow(
    "schema notes: migrations must be numbered 1, 2, 3 … in order; found 1, 3",
  );
  await expect(migrate(untouched, { schema: "notes", migrations: [step(2)] })).rejects.toThrow("found 2");
});

/** A store that answers every statement and records how its connection was released; the unlock can be made to fail. */
function store({ unlockFails = false } = {}) {
  const released: (boolean | undefined)[] = [];
  const database: MigrationDatabase = {
    connect: async () => ({
      async query(text: string) {
        if (unlockFails && text.includes("pg_advisory_unlock")) throw new Error("connection lost");
        return { rows: text.includes("max(version)") ? [{ version: 0 }] : [] };
      },
      release: (destroy?: boolean) => void released.push(destroy),
    }),
  };
  return { database, released };
}

it("returns its connection to the pool once the lock is released", async () => {
  const { database, released } = store();

  expect(await migrate(database, { schema: "notes", migrations: [step(1)] })).toEqual({ from: 0, to: 1 });
  expect(released).toEqual([undefined]);
});

it("discards its connection when the lock cannot be released, so no pooled connection keeps holding it", async () => {
  const { database, released } = store({ unlockFails: true });

  expect(await migrate(database, { schema: "notes", migrations: [step(1)] })).toEqual({ from: 0, to: 1 });
  expect(released).toEqual([true]);
});

it("refuses a schema name that is not a plain lower-case identifier", async () => {
  await expect(migrate(untouched, { schema: "notes; drop table x", migrations: [step(1)] })).rejects.toThrow(
    'schema "notes; drop table x": must be a lower-case identifier',
  );
});

describe("a bundle migrating its stores at start", () => {
  const logged = () => {
    const lines: string[] = [];
    return { lines, log: { log: (line: string) => lines.push(line), error: (line: string) => lines.push(`ERROR ${line}`) } };
  };
  const settledWithin = (promise: Promise<unknown>, ms: number) =>
    Promise.race([promise.then(() => true, () => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);

  it("migrates its domains' stores in order and names those it changed", async () => {
    const order: string[] = [];
    const { lines, log } = logged();
    const stop = vi.fn();

    await migrateOrStop(
      "the database",
      [
        ["orchestration", async (database) => (order.push(`orchestration on ${database}`), { from: 1, to: 3 })],
        ["event bus", async () => (order.push("event bus"), { from: 2, to: 2 })],
      ],
      { bundle: "worker", answers: "GET /health", stop, log },
    );

    expect(order).toEqual(["orchestration on the database", "event bus"]);
    expect(lines).toEqual(["store orchestration: migrated from version 1 to 3"]);
    expect(stop).not.toHaveBeenCalled();
  });

  it("stops at a failed migration: serves only its status endpoint and never starts the rest of the bundle", async () => {
    const failed = new MigrationError("orchestration", "migration 2 (add-index) failed: boom", { version: 2, migration: "add-index" });
    const later = vi.fn(async () => ({ from: 1, to: 1 }));
    const { lines, log } = logged();
    const stop = vi.fn();

    const started = migrateOrStop(
      undefined,
      [
        ["orchestration", () => Promise.reject(failed)],
        ["event bus", later],
      ],
      { bundle: "worker", answers: "GET /health", stop, log },
    );

    expect(await settledWithin(started, 50)).toBe(false);
    expect(stop).toHaveBeenCalledWith(failed);
    expect(later).not.toHaveBeenCalled();
    expect(lines).toEqual([
      "ERROR schema orchestration: migration 2 (add-index) failed: boom; the worker stopped and answers only GET /health until the store is fixed or restored and the worker restarted",
    ]);
  });

  it("passes on any other error, which is a fault of the bundle rather than of the store", async () => {
    await expect(
      migrateOrStop(undefined, [["orchestration", () => Promise.reject(new Error("bug"))]], { bundle: "worker", answers: "GET /health", stop: vi.fn(), log: logged().log }),
    ).rejects.toThrow("bug");
  });
});
