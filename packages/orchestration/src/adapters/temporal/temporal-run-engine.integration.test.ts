import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Connection } from "@temporalio/client";
import { beforeAll, afterAll } from "vitest";
import { describeRunEngine } from "../../runs/run-engine.suite.js";
import { createTemporalRunEngine, createTemporalRunWorker } from "./temporal-run-engine.js";

/* Runs the shared engine suite against a throwaway execution engine in dev mode. */

const run = promisify(execFile);
const docker = async (...args: string[]) => (await run("docker", args)).stdout.trim();

const image = "temporalio/temporal:1.9.1"; // as in deploy/compose.yaml
let container: string;
let address: string;

beforeAll(async () => {
  container = await docker(
    "run", "-d", "--rm", "--label", "dev.tendworks.test=orchestration-run-engine",
    "-p", "127.0.0.1::7233", image, "server", "start-dev", "--ip", "0.0.0.0",
  );
  address = (await docker("port", container, "7233/tcp")).split("\n")[0]!;
  for (let attempt = 0; ; attempt++) {
    try {
      const connection = await Connection.connect({ address, connectTimeout: 1_000 });
      await connection.workflowService.getSystemInfo({});
      await connection.close();
      break;
    } catch (error) {
      if (attempt > 60) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}, 180_000);

afterAll(async () => {
  if (container) await docker("rm", "-f", "-v", container);
});

describeRunEngine("durable execution engine", async (activities) => {
  // A task queue per case keeps the cases' workers apart.
  const taskQueue = `test-${crypto.randomUUID()}`;
  const engine = await createTemporalRunEngine({ address, taskQueue });
  const worker = await createTemporalRunWorker({ address, taskQueue, activities });
  const running = worker.run();
  return {
    engine,
    stop: async () => {
      worker.shutdown();
      await running;
      await engine.close();
    },
  };
});
