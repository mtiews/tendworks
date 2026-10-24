import type { A2A } from "@tendworks/shared";
import { migrate, type Migration } from "@tendworks/platform/migrations";
import type pg from "pg";
import type { HarnessSession } from "../harness.js";
import type { ChatEventPublisher } from "../chat-events.js";
import { TERMINAL_STATES, type StoredTask, type TaskKind, type TaskStore } from "../task-store.js";

/** A task that has not ended; the partial index and the query share it, so the index serves the query. */
const ACTIVE = `(task->'status'->>'state') not in (${TERMINAL_STATES.map((state) => `'${state}'`).join(", ")})`;

// The agent runtime owns the schema `agent_runtime`; no other domain reads these tables.
/**
 * The agent runtime's schema, one migration per change (docs/platform-implementation.md,
 * "Schema migrations").
 */
export const agentRuntimeMigrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
create table agent_runtime.tasks (
  message_id  text primary key,
  task_id     text not null unique,
  agent       text not null,
  started_at  timestamptz not null,
  task        jsonb not null,
  updated_at  timestamptz not null default now(),
  -- The harness session (e.g. the ACP session id), to resume it after a restart.
  session     jsonb,
  -- What kind of work the task is: a run's step (task) or a chat.
  kind        text not null default 'task'
);
create index tasks_kind_started_at on agent_runtime.tasks (kind, started_at desc);
-- The tasks that have not ended: the active agent sessions.
create index tasks_active on agent_runtime.tasks (started_at desc) where ${ACTIVE};
`,
  },
];

/**
 * Brings the agent runtime's tables to the latest version under its advisory lock. Throws
 * `MigrationError` when a migration fails (it is rolled back); the service must stop then.
 */
export function migrateAgentRuntimeStore(pool: pg.Pool): Promise<{ from: number; to: number }> {
  return migrate(pool, { schema: "agent_runtime", migrations: agentRuntimeMigrations });
}

/** The part of a database connection a publisher needs to write inside the store's transaction. */
export interface SqlTransaction {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface PostgresTaskStoreOptions {
  pool: pg.Pool;
  /** Where chat events go, inside the transaction that writes the task (the event bus); without it they are dropped. */
  publisher?: ChatEventPublisher<SqlTransaction>;
}

interface Row {
  message_id: string;
  agent: string;
  started_at: Date;
  task: A2A.Task;
  session: HarnessSession | null;
  kind: TaskKind;
}

const toStored = (row: Row): StoredTask => ({
  messageId: row.message_id,
  agent: row.agent,
  startedAt: row.started_at.toISOString(),
  task: row.task,
  ...(row.kind === "task" ? {} : { kind: row.kind }),
  ...(row.session === null ? {} : { session: row.session }),
});

/** Keeps tasks in Postgres, so they survive a restart of the agent runtime. */
export function createPostgresTaskStore({ pool, publisher }: PostgresTaskStoreOptions): TaskStore {
  const transaction = async <T>(work: (tx: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };
  return {
    async claim(candidate, event) {
      return transaction(async (tx) => {
        // The no-op update makes the existing row come back in the same statement.
        const { rows } = await tx.query<Row & { task_id: string }>(
          `insert into agent_runtime.tasks (message_id, task_id, agent, started_at, task, kind)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (message_id) do update set message_id = excluded.message_id
           returning message_id, task_id, agent, started_at, task, session, kind`,
          [candidate.messageId, candidate.task.id, candidate.agent, candidate.startedAt, JSON.stringify(candidate.task), candidate.kind ?? "task"],
        );
        const claimed = rows[0]!;
        if (event && publisher && claimed.task_id === candidate.task.id) await publisher.publish(tx, event);
        return toStored(claimed);
      });
    },
    async update(task, event) {
      await transaction(async (tx) => {
        const { rowCount } = await tx.query("update agent_runtime.tasks set task = $2, updated_at = now() where task_id = $1", [task.id, JSON.stringify(task)]);
        if (rowCount === 0) throw new Error(`no such task: ${task.id}`);
        if (event && publisher) await publisher.publish(tx, event);
      });
    },
    async list({ kind }) {
      const { rows } = await pool.query<Pick<Row, "task">>("select task from agent_runtime.tasks where kind = $1 order by started_at desc, updated_at desc", [kind]);
      return rows.map((row) => row.task);
    },
    async active() {
      const { rows } = await pool.query<Row>(
        `select message_id, agent, started_at, task, session, kind from agent_runtime.tasks where ${ACTIVE} order by started_at desc, updated_at desc`,
      );
      return rows.map(toStored);
    },
    async get(taskId) {
      const { rows } = await pool.query<Pick<Row, "task">>("select task from agent_runtime.tasks where task_id = $1", [taskId]);
      return rows[0]?.task;
    },
    async find(taskId) {
      const { rows } = await pool.query<Row>("select message_id, agent, started_at, task, session, kind from agent_runtime.tasks where task_id = $1", [taskId]);
      return rows[0] && toStored(rows[0]);
    },
    async saveSession(taskId, session) {
      const { rowCount } = await pool.query("update agent_runtime.tasks set session = $2, updated_at = now() where task_id = $1", [
        taskId,
        JSON.stringify(session),
      ]);
      if (rowCount === 0) throw new Error(`no such task: ${taskId}`);
    },
  };
}
