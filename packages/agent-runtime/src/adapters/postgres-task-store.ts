import type { A2A } from "@tendworks/shared";
import type pg from "pg";
import type { HarnessSession } from "../harness.js";
import type { ChatEventPublisher } from "../chat-events.js";
import type { StoredTask, TaskKind, TaskStore } from "../task-store.js";

// The agent runtime owns the schema `agent_runtime`; no other domain reads these tables.
const SCHEMA = `
create schema if not exists agent_runtime;
create table if not exists agent_runtime.tasks (
  message_id  text primary key,
  task_id     text not null unique,
  agent       text not null,
  started_at  timestamptz not null,
  task        jsonb not null,
  updated_at  timestamptz not null default now()
);
-- The harness session (e.g. the ACP session id), to resume it after a restart.
alter table agent_runtime.tasks add column if not exists session jsonb;
-- What kind of work the task is: a run's step (task) or a chat.
alter table agent_runtime.tasks add column if not exists kind text not null default 'task';
create index if not exists tasks_kind_started_at on agent_runtime.tasks (kind, started_at desc);
`;

/** Creates the agent runtime's tables if they do not exist yet. */
export async function migrateAgentRuntimeStore(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Serialises concurrent starts of several workers.
    await client.query("select pg_advisory_lock(hashtext('agent_runtime.migrate'))");
    await client.query(SCHEMA);
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('agent_runtime.migrate'))").catch(() => {});
    client.release();
  }
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
