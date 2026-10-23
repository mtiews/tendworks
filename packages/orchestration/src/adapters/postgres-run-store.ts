import pg from "pg";
import { migrate, type Migration } from "@tendworks/platform/migrations";
import type { EventPublisher, RunEvent } from "../runs/run-events.js";
import type { Run, RunPatch, RunStore, StepRecord, StepTask } from "../runs/run-store.js";

/** The part of a database connection a publisher needs to write inside the store's transaction. */
export interface SqlTransaction {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

// Orchestration owns the schema `orchestration`; no other domain reads these tables.
/**
 * Orchestration's schema, one migration per change (docs/platform-implementation.md,
 * "Schema migrations"). Migration 1 is the schema as the store created it before versioned
 * migrations; its `if not exists` statements adopt such a store with its data.
 */
export const orchestrationMigrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
create schema if not exists orchestration;
create table if not exists orchestration.runs (
  position    bigserial unique,
  id          text primary key,
  workflow    text not null,
  status      text not null,
  input       jsonb not null,
  output      jsonb,
  error       jsonb,
  created_at  timestamptz not null,
  started_at  timestamptz,
  finished_at timestamptz
);
create table if not exists orchestration.steps (
  run_id      text not null references orchestration.runs (id) on delete cascade,
  reference   text not null,
  position    bigserial,
  name        text not null,
  status      text not null,
  task_id     text,
  error       jsonb,
  started_at  timestamptz not null,
  finished_at timestamptz,
  primary key (run_id, reference)
);
alter table orchestration.steps add column if not exists transcript text;
alter table orchestration.steps add column if not exists cost jsonb;
alter table orchestration.steps add column if not exists artifacts jsonb;
alter table orchestration.runs add column if not exists traceparent text;
alter table orchestration.steps add column if not exists workspace jsonb;
alter table orchestration.runs add column if not exists started_by jsonb;
create table if not exists orchestration.outbox (
  position   bigserial primary key,
  id         text not null unique,
  type       text not null,
  run_id     text not null,
  event      jsonb not null,
  created_at timestamptz not null default now()
);
`,
  },
];

/**
 * Brings orchestration's tables to the latest version under its advisory lock. Throws
 * `MigrationError` when a migration fails (it is rolled back); the service must stop then.
 */
export function migrateOrchestrationStore(pool: pg.Pool): Promise<{ from: number; to: number }> {
  return migrate(pool, { schema: "orchestration", migrations: orchestrationMigrations });
}

/**
 * Stores events in orchestration's outbox table, in the transaction of the state change.
 * Delivery over the event bus follows; until then the outbox is the durable record.
 */
export function createPostgresOutbox(pool: pg.Pool): EventPublisher<SqlTransaction> & { events(runId: string): Promise<RunEvent[]> } {
  return {
    async publish(tx, event) {
      await tx.query(
        "insert into orchestration.outbox (id, type, run_id, event) values ($1, $2, $3, $4) on conflict (id) do nothing",
        [event.id, event.type, event.runid, JSON.stringify(event)],
      );
    },
    async events(runId) {
      const { rows } = await pool.query<{ event: RunEvent }>(
        "select event from orchestration.outbox where run_id = $1 order by position",
        [runId],
      );
      return rows.map((row) => row.event);
    },
  };
}

interface RunRow {
  id: string;
  workflow: string;
  status: Run["status"];
  input: unknown;
  started_by: NonNullable<Run["startedBy"]> | null;
  traceparent: string | null;
  output: unknown;
  error: NonNullable<Run["error"]> | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

interface StepRow {
  run_id: string;
  reference: string;
  name: string;
  status: StepRecord["status"];
  task_id: string | null;
  transcript: string | null;
  cost: NonNullable<StepRecord["cost"]> | null;
  workspace: NonNullable<StepRecord["workspace"]> | null;
  artifacts: NonNullable<StepRecord["artifacts"]> | null;
  error: NonNullable<StepRecord["error"]> | null;
  started_at: Date;
  finished_at: Date | null;
}

export interface PostgresRunStoreOptions {
  pool: pg.Pool;
  /** Where events go; defaults to orchestration's outbox table. */
  publisher?: EventPublisher<SqlTransaction>;
}

/** Run store on Postgres. Call {@link migrateOrchestrationStore} once before use. */
export function createPostgresRunStore({ pool, publisher = createPostgresOutbox(pool) }: PostgresRunStoreOptions): RunStore {
  const transaction = async (write: (tx: pg.PoolClient) => Promise<void>, events: RunEvent[]) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await write(client);
      for (const event of events) await publisher.publish(client, event);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));

  const read = async (where: string, values: unknown[], limit?: number): Promise<Run[]> => {
    const { rows } = await pool.query<RunRow>(
      `select * from orchestration.runs ${where} order by position desc${limit === undefined ? "" : ` limit ${limit}`}`,
      values,
    );
    if (rows.length === 0) return [];
    const steps = await pool.query<StepRow>(
      "select * from orchestration.steps where run_id = any($1) order by position",
      [rows.map((row) => row.id)],
    );
    return rows.map((row) => toRun(row, steps.rows.filter((step) => step.run_id === row.id)));
  };

  return {
    async create(run) {
      await pool.query(
        `insert into orchestration.runs (id, workflow, status, input, started_by, traceparent, output, error, created_at, started_at, finished_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          run.id, run.workflow, run.status, json(run.input), json(run.startedBy), run.traceparent ?? null, json(run.output), json(run.error),
          run.createdAt, run.startedAt ?? null, run.finishedAt ?? null,
        ],
      );
    },
    async updateRun(runId: string, patch: RunPatch, events) {
      const columns: Record<keyof RunPatch, string> = {
        status: "status",
        output: "output",
        error: "error",
        startedAt: "started_at",
        finishedAt: "finished_at",
      };
      const entries = (Object.keys(columns) as (keyof RunPatch)[]).filter((key) => patch[key] !== undefined);
      const values = entries.map((key) => (key === "output" || key === "error" ? json(patch[key]) : patch[key]));
      await transaction(async (tx) => {
        if (entries.length === 0) return;
        const set = entries.map((key, index) => `${columns[key]} = $${index + 2}`).join(", ");
        const result = await tx.query(`update orchestration.runs set ${set} where id = $1`, [runId, ...values]);
        if (result.rowCount === 0) throw new Error(`unknown run ${runId}`);
      }, events);
    },
    async saveStep(runId, step, events) {
      await transaction(async (tx) => {
        await tx.query(
          `insert into orchestration.steps (run_id, reference, name, status, task_id, transcript, cost, workspace, artifacts, error, started_at, finished_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           on conflict (run_id, reference) do update set
             name = excluded.name, status = excluded.status, task_id = excluded.task_id,
             transcript = excluded.transcript, cost = excluded.cost, workspace = excluded.workspace, artifacts = excluded.artifacts,
             error = excluded.error, finished_at = excluded.finished_at`,
          [
            runId, step.reference, step.name, step.status, step.taskId ?? null, step.transcript ?? null, json(step.cost), json(step.workspace),
            json(step.artifacts), json(step.error), step.startedAt, step.finishedAt ?? null,
          ],
        );
      }, events);
    },
    async nameTask(runId: string, reference: string, { taskId, transcript }: StepTask) {
      await pool.query(
        "update orchestration.steps set task_id = $3, transcript = $4 where run_id = $1 and reference = $2 and status = 'running'",
        [runId, reference, taskId, transcript ?? null],
      );
    },
    async get(runId) {
      return (await read("where id = $1", [runId]))[0];
    },
    async list({ limit = 100 } = {}) {
      return read("", [], Math.max(1, Math.floor(limit)));
    },
  };
}

function toRun(row: RunRow, steps: StepRow[]): Run {
  return {
    id: row.id,
    workflow: row.workflow,
    status: row.status,
    input: row.input,
    ...(row.started_by === null ? {} : { startedBy: row.started_by }),
    ...(row.traceparent === null ? {} : { traceparent: row.traceparent }),
    ...(row.output === null ? {} : { output: row.output }),
    ...(row.error === null ? {} : { error: row.error }),
    steps: steps.map(toStep),
    createdAt: row.created_at.toISOString(),
    ...(row.started_at === null ? {} : { startedAt: row.started_at.toISOString() }),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at.toISOString() }),
  };
}

function toStep(row: StepRow): StepRecord {
  return {
    name: row.name,
    reference: row.reference,
    status: row.status,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.transcript === null ? {} : { transcript: row.transcript }),
    ...(row.cost === null ? {} : { cost: row.cost }),
    ...(row.workspace === null ? {} : { workspace: row.workspace }),
    ...(row.artifacts === null ? {} : { artifacts: row.artifacts }),
    ...(row.error === null ? {} : { error: row.error }),
    startedAt: row.started_at.toISOString(),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at.toISOString() }),
  };
}
