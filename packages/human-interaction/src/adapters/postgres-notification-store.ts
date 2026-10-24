import pg from "pg";
import { migrate, type Migration } from "@tendworks/platform/migrations";
import type { Notification } from "../notification-channel.js";
import type { NotificationStore } from "../notification-store.js";

// Human interaction owns the schema `human_interaction`; no other domain reads these tables.
/**
 * Human interaction's schema, one migration per change (docs/platform-implementation.md,
 * "Schema migrations"). Migration 1 is the schema as the store created it before versioned
 * migrations; its `if not exists` statements adopt such a store with its data.
 */
export const humanInteractionMigrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
create schema if not exists human_interaction;
create table if not exists human_interaction.notifications (
  position   bigserial unique,
  id         text primary key,
  cause      text not null unique,
  kind       text not null,
  run_id     text not null,
  title      text not null,
  detail     text,
  created_at timestamptz not null,
  delivery   jsonb not null
);
create table if not exists human_interaction.approval_requests (
  position     bigserial unique,
  id           text primary key,
  run_id       text not null,
  workflow     text not null,
  action       text not null,
  policy       text not null,
  question     text not null,
  status       text not null,
  created_at   timestamptz not null,
  decided_at   timestamptz,
  unique (run_id, action)
);
alter table human_interaction.approval_requests add column if not exists traceparent text;
`,
  },
];

/**
 * Brings human interaction's tables to the latest version under its advisory lock. Throws
 * `MigrationError` when a migration fails (it is rolled back); the service must stop then.
 */
export function migrateHumanInteractionStore(pool: pg.Pool): Promise<{ from: number; to: number }> {
  return migrate(pool, { schema: "human_interaction", migrations: humanInteractionMigrations });
}

interface NotificationRow {
  id: string;
  kind: Notification["kind"];
  run_id: string;
  title: string;
  detail: string | null;
  created_at: Date;
  delivery: Notification["delivery"];
}

/** Notification store on Postgres. Call {@link migrateHumanInteractionStore} once before use. */
export function createPostgresNotificationStore(pool: pg.Pool): NotificationStore {
  return {
    async record(cause, notification) {
      await pool.query(
        `insert into human_interaction.notifications (id, cause, kind, run_id, title, detail, created_at, delivery)
         values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (cause) do nothing`,
        [
          notification.id,
          cause,
          notification.kind,
          notification.runId,
          notification.title,
          notification.detail ?? null,
          notification.createdAt,
          JSON.stringify(notification.delivery),
        ],
      );
      const { rows } = await pool.query<NotificationRow>("select * from human_interaction.notifications where cause = $1", [cause]);
      return toNotification(rows[0]!);
    },
    async updateDelivery(id, delivery) {
      const result = await pool.query("update human_interaction.notifications set delivery = $2 where id = $1", [id, JSON.stringify(delivery)]);
      if (result.rowCount === 0) throw new Error(`unknown notification ${id}`);
    },
    async list({ limit = 100 } = {}) {
      const { rows } = await pool.query<NotificationRow>("select * from human_interaction.notifications order by position desc limit $1", [
        Math.max(1, Math.floor(limit)),
      ]);
      return rows.map(toNotification);
    },
  };
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    kind: row.kind,
    runId: row.run_id,
    title: row.title,
    ...(row.detail === null ? {} : { detail: row.detail }),
    createdAt: row.created_at.toISOString(),
    delivery: row.delivery,
  };
}
