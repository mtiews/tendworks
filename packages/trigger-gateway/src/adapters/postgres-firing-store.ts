import pg from "pg";
import { migrate, type Migration } from "@tendworks/platform/migrations";
import type { Evaluation, FiringStore } from "../firings/firing-store.js";
import type { EventPublisher, TriggerFiredEvent } from "../trigger-events.js";

/** The part of a database connection a publisher needs to write inside the store's transaction. */
export interface SqlTransaction {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

// The trigger gateway owns the schema `trigger_gateway`; no other domain reads these tables.
/**
 * The trigger gateway's schema, one migration per change (docs/platform-implementation.md,
 * "Schema migrations"). Migration 1 is the schema as the store created it before versioned
 * migrations; its `if not exists` statements adopt such a store with its data.
 */
export const triggerGatewayMigrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
create schema if not exists trigger_gateway;
create table if not exists trigger_gateway.firings (
  binding    text not null,
  -- empty for a binding without workspaces
  workspace  text not null,
  item       text not null,
  run_id     text,
  claimed_at timestamptz not null default now(),
  fired_at   timestamptz,
  primary key (binding, workspace, item)
);
create table if not exists trigger_gateway.evaluations (
  binding       text primary key,
  at            timestamptz not null,
  status        text not null,
  started_runs  integer not null,
  message       text
);
create table if not exists trigger_gateway.outbox (
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
 * Brings the trigger gateway's tables to the latest version under its advisory lock. Throws
 * `MigrationError` when a migration fails (it is rolled back); the service must stop then.
 */
export function migrateTriggerGatewayStore(pool: pg.Pool): Promise<{ from: number; to: number }> {
  return migrate(pool, { schema: "trigger_gateway", migrations: triggerGatewayMigrations });
}

/**
 * Stores events in the trigger gateway's own outbox table, in the transaction of the firing.
 * Default publisher for tests; the server bundle passes the event bus instead (ADR 0005).
 */
export function createPostgresOutbox(pool: pg.Pool): EventPublisher<SqlTransaction> & { events(): Promise<TriggerFiredEvent[]> } {
  return {
    async publish(tx, event) {
      await tx.query(
        "insert into trigger_gateway.outbox (id, type, run_id, event) values ($1, $2, $3, $4) on conflict (id) do nothing",
        [event.id, event.type, event.runid, JSON.stringify(event)],
      );
    },
    async events() {
      const { rows } = await pool.query<{ event: TriggerFiredEvent }>("select event from trigger_gateway.outbox order by position");
      return rows.map((row) => row.event);
    },
  };
}

export interface PostgresFiringStoreOptions {
  pool: pg.Pool;
  /** Where events go; defaults to the trigger gateway's outbox table. */
  publisher?: EventPublisher<SqlTransaction>;
}

/** Firing store on Postgres. Call {@link migrateTriggerGatewayStore} once before use. */
export function createPostgresFiringStore({ pool, publisher = createPostgresOutbox(pool) }: PostgresFiringStoreOptions): FiringStore {
  return {
    async claim({ binding, workspace, item }) {
      const result = await pool.query(
        "insert into trigger_gateway.firings (binding, workspace, item) values ($1, $2, $3) on conflict do nothing",
        [binding, workspace, item],
      );
      return result.rowCount === 1;
    },
    async release({ binding, workspace, item }) {
      await pool.query("delete from trigger_gateway.firings where binding = $1 and workspace = $2 and item = $3 and run_id is null", [binding, workspace, item]);
    },
    async fired({ binding, workspace, item }, runId, event) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query(
          `insert into trigger_gateway.firings (binding, workspace, item, run_id, fired_at) values ($1, $2, $3, $4, now())
           on conflict (binding, workspace, item) do update set run_id = excluded.run_id, fired_at = excluded.fired_at
           where trigger_gateway.firings.run_id is null`,
          [binding, workspace, item, runId],
        );
        if (result.rowCount === 1) await publisher.publish(client, event);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async recordEvaluation(binding, { at, status, startedRuns, message }) {
      await pool.query(
        `insert into trigger_gateway.evaluations (binding, at, status, started_runs, message) values ($1, $2, $3, $4, $5)
         on conflict (binding) do update set at = excluded.at, status = excluded.status, started_runs = excluded.started_runs, message = excluded.message`,
        [binding, at, status, startedRuns, message ?? null],
      );
    },
    async lastEvaluations() {
      const { rows } = await pool.query<{ binding: string; at: Date; status: Evaluation["status"]; started_runs: number; message: string | null }>(
        "select * from trigger_gateway.evaluations",
      );
      return new Map(
        rows.map((row) => [
          row.binding,
          { at: row.at.toISOString(), status: row.status, startedRuns: row.started_runs, ...(row.message === null ? {} : { message: row.message }) },
        ]),
      );
    },
  };
}
