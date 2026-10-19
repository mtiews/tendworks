import pg from "pg";
import type { FiringStore } from "../firings/firing-store.js";
import type { EventPublisher, TriggerFiredEvent } from "../trigger-events.js";

/** The part of a database connection a publisher needs to write inside the store's transaction. */
export interface SqlTransaction {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

// The trigger gateway owns the schema `trigger_gateway`; no other domain reads these tables.
const SCHEMA = `
create schema if not exists trigger_gateway;
create table if not exists trigger_gateway.firings (
  binding    text not null,
  item       text not null,
  run_id     text,
  claimed_at timestamptz not null default now(),
  fired_at   timestamptz,
  primary key (binding, item)
);
create table if not exists trigger_gateway.outbox (
  position   bigserial primary key,
  id         text not null unique,
  type       text not null,
  run_id     text not null,
  event      jsonb not null,
  created_at timestamptz not null default now()
);
`;

/** Creates the trigger gateway's tables if they do not exist yet. */
export async function migrateTriggerGatewayStore(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Serialises concurrent starts of several servers.
    await client.query("select pg_advisory_lock(hashtext('trigger_gateway.migrate'))");
    await client.query(SCHEMA);
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('trigger_gateway.migrate'))").catch(() => {});
    client.release();
  }
}

/**
 * Stores events in the trigger gateway's own outbox table, in the transaction of the firing.
 * Default publisher for tests; the server bundle passes the event bus instead (ADR 0004).
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
    async claim({ binding, item }) {
      const result = await pool.query(
        "insert into trigger_gateway.firings (binding, item) values ($1, $2) on conflict do nothing",
        [binding, item],
      );
      return result.rowCount === 1;
    },
    async release({ binding, item }) {
      await pool.query("delete from trigger_gateway.firings where binding = $1 and item = $2 and run_id is null", [binding, item]);
    },
    async fired({ binding, item }, runId, event) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query(
          `insert into trigger_gateway.firings (binding, item, run_id, fired_at) values ($1, $2, $3, now())
           on conflict (binding, item) do update set run_id = excluded.run_id, fired_at = excluded.fired_at
           where trigger_gateway.firings.run_id is null`,
          [binding, item, runId],
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
  };
}
