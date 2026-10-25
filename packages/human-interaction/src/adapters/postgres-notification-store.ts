import pg from "pg";
import { migrate, type Migration } from "@tendworks/platform/migrations";
import type { Notification } from "../notification-delivery.js";
import type { NotificationStore } from "../notification-store.js";

// Human interaction owns the schema `human_interaction`; no other domain reads these tables.
/**
 * Human interaction's schema, one migration per change (docs/platform-implementation.md,
 * "Schema migrations").
 */
export const humanInteractionMigrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
create table human_interaction.notifications (
  position   bigserial unique,
  id         text primary key,
  cause      text not null unique,
  kind       text not null,
  run_id     text,
  title      text not null,
  detail     text,
  artifacts  jsonb,
  created_at timestamptz not null,
  deliveries jsonb not null
);
create table human_interaction.approval_requests (
  position     bigserial unique,
  id           text primary key,
  run_id       text not null,
  workflow     text not null,
  step         text not null,
  action       text not null,
  policy       text,
  question     text not null,
  links        jsonb not null,
  answers      jsonb not null,
  status       text not null,
  answer       text,
  created_at   timestamptz not null,
  decided_at   timestamptz,
  traceparent  text,
  unique (run_id, step)
);
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
  run_id: string | null;
  title: string;
  detail: string | null;
  artifacts: NonNullable<Notification["artifacts"]> | null;
  created_at: Date;
  deliveries: Notification["deliveries"];
}

/** Notification store on Postgres. Call {@link migrateHumanInteractionStore} once before use. */
export function createPostgresNotificationStore(pool: pg.Pool): NotificationStore {
  return {
    async record(cause, notification) {
      await pool.query(
        `insert into human_interaction.notifications (id, cause, kind, run_id, title, detail, artifacts, created_at, deliveries)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (cause) do nothing`,
        [
          notification.id,
          cause,
          notification.kind,
          notification.runId ?? null,
          notification.title,
          notification.detail ?? null,
          notification.artifacts === undefined ? null : JSON.stringify(notification.artifacts),
          notification.createdAt,
          JSON.stringify(notification.deliveries),
        ],
      );
      const { rows } = await pool.query<NotificationRow>("select * from human_interaction.notifications where cause = $1", [cause]);
      return toNotification(rows[0]!);
    },
    // Replaces only the channel's entry, in one statement, so outcomes of other channels stored meanwhile are kept.
    async updateDelivery(id, delivery) {
      const result = await pool.query(
        `update human_interaction.notifications
            set deliveries = (
              select jsonb_agg(case when entry->>'channel' = $2 then $3::jsonb else entry end order by position)
                from jsonb_array_elements(deliveries) with ordinality as entries(entry, position))
          where id = $1 and deliveries @> jsonb_build_array(jsonb_build_object('channel', $2::text))`,
        [id, delivery.channel, JSON.stringify(delivery)],
      );
      if (result.rowCount !== 0) return;
      const known = await pool.query("select 1 from human_interaction.notifications where id = $1", [id]);
      throw new Error(known.rowCount === 0 ? `unknown notification ${id}` : `notification ${id} has no delivery through channel ${delivery.channel}`);
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
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    title: row.title,
    ...(row.detail === null ? {} : { detail: row.detail }),
    ...(row.artifacts === null ? {} : { artifacts: row.artifacts }),
    createdAt: row.created_at.toISOString(),
    deliveries: row.deliveries,
  };
}
