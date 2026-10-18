import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@temporalio/activity";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { RunActivities } from "../../runs/execute-run.js";
import type { RunEngine } from "../../runs/run-engine.js";
import type { executeRunWorkflow } from "./workflows.js";

export interface TemporalOptions {
  /** Address of the execution engine's frontend, e.g. `temporal:7233`. */
  address: string;
  namespace?: string;
  taskQueue?: string;
}

const defaults = { namespace: "default", taskQueue: "tend-runs" };

/** Starts runs on the durable execution engine. */
export async function createTemporalRunEngine(options: TemporalOptions): Promise<RunEngine & { close(): Promise<void> }> {
  const { address, namespace, taskQueue } = { ...defaults, ...options };
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });
  return {
    async start(execution) {
      await client.workflow.start<typeof executeRunWorkflow>("executeRunWorkflow", {
        taskQueue,
        // Our run id, never the engine's internal one.
        workflowId: execution.runId,
        args: [execution],
        workflowIdConflictPolicy: "FAIL",
        workflowIdReusePolicy: "REJECT_DUPLICATE",
      });
    },
    close: () => connection.close(),
  };
}

export interface TemporalRunWorker {
  /** Polls for work until {@link TemporalRunWorker.shutdown}; rejects when the worker fails. */
  run(): Promise<void>;
  shutdown(): void;
}

/** Executes runs from the engine's task queue with the given activities. */
export async function createTemporalRunWorker(options: TemporalOptions & { activities: RunActivities }): Promise<TemporalRunWorker> {
  const { address, namespace, taskQueue } = { ...defaults, ...options };
  const connection = await NativeConnection.connect({ address });
  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    // Source (.ts) under tests, compiled (.js) in the bundle.
    workflowsPath: fileURLToPath(new URL(`./workflows${extname(import.meta.url)}`, import.meta.url)),
    activities: withHeartbeat(options.activities),
  });
  return {
    run: async () => {
      try {
        await worker.run();
      } finally {
        await connection.close();
      }
    },
    shutdown: () => worker.shutdown(),
  };
}

function withHeartbeat(activities: RunActivities): RunActivities {
  return {
    ...activities,
    async sendMessage(agent, request) {
      const context = Context.current();
      const timer = setInterval(() => context.heartbeat(), 5_000);
      try {
        return await activities.sendMessage(agent, request);
      } finally {
        clearInterval(timer);
      }
    },
  };
}
