import { expect, it } from "vitest";
import { migrate, type MigrationDatabase } from "./migrations.js";

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

it("refuses a schema name that is not a plain lower-case identifier", async () => {
  await expect(migrate(untouched, { schema: "notes; drop table x", migrations: [step(1)] })).rejects.toThrow(
    'schema "notes; drop table x": must be a lower-case identifier',
  );
});
