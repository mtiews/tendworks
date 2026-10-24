import pg from "pg";
import type { ApprovalEventPublisher, ApprovalRequest, ApprovalStore } from "../approvals/approval-store.js";

/** The part of a database connection a publisher needs to write inside the store's transaction. */
export interface SqlTransaction {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

interface ApprovalRow {
  id: string;
  run_id: string;
  workflow: string;
  action: ApprovalRequest["action"];
  policy: string;
  question: string;
  status: ApprovalRequest["status"];
  traceparent: string | null;
  created_at: Date;
  decided_at: Date | null;
}

export interface PostgresApprovalStoreOptions {
  pool: pg.Pool;
  /** Where approval events go, inside the transaction that writes the request (the event bus). */
  publisher: ApprovalEventPublisher<SqlTransaction>;
}

/**
 * Approval store on Postgres (table `human_interaction.approval_requests`). Call
 * `migrateHumanInteractionStore` once before use.
 */
export function createPostgresApprovalStore({ pool, publisher }: PostgresApprovalStoreOptions): ApprovalStore {
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
  const one = async (client: pg.Pool | pg.PoolClient, where: string, values: unknown[], lock = "") => {
    const { rows } = await client.query<ApprovalRow>(`select * from human_interaction.approval_requests where ${where}${lock}`, values);
    return rows[0] && toRequest(rows[0]);
  };

  return {
    async open(request, event) {
      return transaction(async (tx) => {
        const inserted = await tx.query(
          `insert into human_interaction.approval_requests (id, run_id, workflow, action, policy, question, status, traceparent, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (run_id, action) do nothing`,
          [
            request.id, request.runId, request.workflow, request.action, request.policy, request.question, request.status,
            request.traceparent ?? null, request.createdAt,
          ],
        );
        if (inserted.rowCount === 1) {
          await publisher.publish(tx, event(request));
          return structuredClone(request);
        }
        return (await one(tx, "run_id = $1 and action = $2", [request.runId, request.action]))!;
      });
    },
    async decide(id, status, decidedAt, event) {
      return transaction(async (tx) => {
        const request = await one(tx, "id = $1", [id], " for update");
        if (!request) return undefined;
        if (request.status !== "pending") return request.status === status ? { decided: request } : { conflict: request };
        await tx.query("update human_interaction.approval_requests set status = $2, decided_at = $3 where id = $1", [id, status, decidedAt]);
        const decided = { ...request, status, decidedAt: new Date(decidedAt).toISOString() };
        await publisher.publish(tx, event(decided));
        return { decided };
      });
    },
    get: (id) => one(pool, "id = $1", [id]),
    async list({ status, limit = 100 } = {}) {
      const { rows } = await pool.query<ApprovalRow>(
        `select * from human_interaction.approval_requests where ($1::text is null or status = $1) order by position desc limit $2`,
        [status ?? null, Math.max(1, Math.floor(limit))],
      );
      return rows.map(toRequest);
    },
  };
}

function toRequest(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    runId: row.run_id,
    workflow: row.workflow,
    action: row.action,
    policy: row.policy,
    question: row.question,
    status: row.status,
    ...(row.traceparent === null ? {} : { traceparent: row.traceparent }),
    createdAt: row.created_at.toISOString(),
    ...(row.decided_at === null ? {} : { decidedAt: row.decided_at.toISOString() }),
  };
}
