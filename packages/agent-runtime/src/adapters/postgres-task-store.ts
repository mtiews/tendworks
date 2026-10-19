import type { A2A } from "@tendworks/shared";
import type pg from "pg";
import type { StoredTask, TaskStore } from "../task-store.js";

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

export interface PostgresTaskStoreOptions {
  pool: pg.Pool;
}

interface Row {
  message_id: string;
  agent: string;
  started_at: Date;
  task: A2A.Task;
}

const toStored = (row: Row): StoredTask => ({
  messageId: row.message_id,
  agent: row.agent,
  startedAt: row.started_at.toISOString(),
  task: row.task,
});

/** Keeps tasks in Postgres, so they survive a restart of the agent runtime. */
export function createPostgresTaskStore({ pool }: PostgresTaskStoreOptions): TaskStore {
  return {
    async claim(candidate) {
      // The no-op update makes the existing row come back in the same statement.
      const { rows } = await pool.query<Row>(
        `insert into agent_runtime.tasks (message_id, task_id, agent, started_at, task)
         values ($1, $2, $3, $4, $5)
         on conflict (message_id) do update set message_id = excluded.message_id
         returning message_id, agent, started_at, task`,
        [candidate.messageId, candidate.task.id, candidate.agent, candidate.startedAt, JSON.stringify(candidate.task)],
      );
      return toStored(rows[0]!);
    },
    async update(task) {
      const { rowCount } = await pool.query("update agent_runtime.tasks set task = $2, updated_at = now() where task_id = $1", [
        task.id,
        JSON.stringify(task),
      ]);
      if (rowCount === 0) throw new Error(`no such task: ${task.id}`);
    },
    async get(taskId) {
      const { rows } = await pool.query<Pick<Row, "task">>("select task from agent_runtime.tasks where task_id = $1", [taskId]);
      return rows[0]?.task;
    },
  };
}
