import pg from "pg";
import type { BusEvent, EventBus, EventHandler, RetryOptions, SubscribeOptions } from "../event-bus.js";
import { Pump } from "../pump.js";

/** The part of a producer's database connection the bus needs to write inside its transaction. */
export interface SqlTransaction {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

// The event bus owns the schema `event_bus`. Producers never touch it directly; they hand
// their open transaction to `publish`, which is why they must share the database.
const SCHEMA = `
create schema if not exists event_bus;
create table if not exists event_bus.events (
  position   bigserial primary key,
  source     text not null,
  id         text not null,
  type       text not null,
  event      jsonb not null,
  created_at timestamptz not null default now(),
  unique (source, id)
);
create index if not exists events_type_position on event_bus.events (type, position);
create table if not exists event_bus.subscriptions (
  name     text primary key,
  position bigint not null default 0
);
`;

const CHANNEL = "tend_events";

/** Creates the bus's tables if they do not exist yet. Safe to call from every bundle. */
export async function migrateEventBus(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('event_bus.migrate'))");
    await client.query(SCHEMA);
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('event_bus.migrate'))").catch(() => {});
    client.release();
  }
}

export interface PostgresEventBusOptions extends RetryOptions {
  pool: pg.Pool;
  /** Safety poll; NOTIFY is only a hint and is lost while the listener reconnects. */
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * Event bus on Postgres: an event table written in the producer's transaction (outbox),
 * LISTEN/NOTIFY to wake subscribers, and a stored position per subscription.
 * Call {@link migrateEventBus} once before use.
 */
export function createPostgresEventBus({
  pool,
  pollIntervalMs = 5_000,
  onError = (error) => console.error("event bus:", error),
  ...retry
}: PostgresEventBusOptions): EventBus<SqlTransaction> {
  const pumps: Pump[] = [];
  const wakeAll = () => pumps.forEach((pump) => pump.wake());
  let listener: pg.Client | undefined;
  let listening: Promise<void> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  // A dedicated session: LISTEN belongs to a connection, so it must not go back to the pool.
  const listen = async (): Promise<void> => {
    const client = new pg.Client(pool.options);
    listener = client;
    client.on("notification", wakeAll);
    client.on("error", (error) => {
      onError(error);
      client.end().catch(() => {});
      if (!closed && listener === client) reconnect = setTimeout(() => void listen().catch(onError), 1_000);
    });
    try {
      await client.connect();
      await client.query(`listen ${CHANNEL}`);
    } catch (error) {
      client.end().catch(() => {});
      if (!closed && listener === client) reconnect = setTimeout(() => void listen().catch(onError), 1_000);
      throw error;
    }
    // Notifications sent while not listening are lost; catch up.
    wakeAll();
  };

  const deliverNext = async (name: string, handler: EventHandler, types: string[] | null): Promise<boolean> => {
    const client = await pool.connect();
    try {
      await client.query("insert into event_bus.subscriptions (name) values ($1) on conflict (name) do nothing", [name]);
      await client.query("begin");
      // One consumer per subscription across instances; the others skip it.
      const subscription = await client.query<{ position: string }>(
        "select position from event_bus.subscriptions where name = $1 for update skip locked",
        [name],
      );
      const position = subscription.rows[0]?.position;
      if (position === undefined) {
        await client.query("rollback");
        return false;
      }
      const next = await client.query<{ position: string; event: BusEvent }>(
        `select position, event from event_bus.events
         where position > $1 and ($2::text[] is null or type = any($2))
         order by position limit 1`,
        [position, types],
      );
      const row = next.rows[0];
      if (!row) {
        await client.query("commit");
        return false;
      }
      await handler(row.event);
      await client.query("update event_bus.subscriptions set position = $2 where name = $1", [name, row.position]);
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  return {
    async publish(tx, event) {
      // Serialises publishers until commit, so positions become visible in order and a
      // subscriber never skips an event whose transaction commits late.
      await tx.query("select pg_advisory_xact_lock(hashtext('event_bus.publish'))");
      await tx.query(
        "insert into event_bus.events (source, id, type, event) values ($1, $2, $3, $4) on conflict (source, id) do nothing",
        [event.source, event.id, event.type, JSON.stringify(event)],
      );
      await tx.query("select pg_notify($1, '')", [CHANNEL]);
    },
    subscribe<E extends BusEvent>(name: string, handler: EventHandler<E>, options: SubscribeOptions = {}) {
      const pump = new Pump(() => deliverNext(name, handler as EventHandler, options.types ?? null), { ...retry, onError });
      pumps.push(pump);
      listening ??= listen().catch(onError);
      poll ??= setInterval(wakeAll, pollIntervalMs);
      pump.wake();
    },
    async close() {
      closed = true;
      clearInterval(poll);
      clearTimeout(reconnect);
      await Promise.all(pumps.splice(0).map((pump) => pump.close()));
      await listening;
      await listener?.end().catch(() => {});
    },
  };
}
