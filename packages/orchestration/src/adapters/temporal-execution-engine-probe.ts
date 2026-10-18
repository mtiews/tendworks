import { Connection } from "@temporalio/client";
import type { HealthProbe } from "@tendworks/health";

/** Checks that the durable execution engine answers. */
export function createExecutionEngineProbe(address: string): HealthProbe {
  return {
    name: "execution-engine",
    async check() {
      const connection = await Connection.connect({ address, connectTimeout: 1_500 });
      try {
        await connection.workflowService.getSystemInfo({});
        return { status: "healthy" };
      } finally {
        await connection.close();
      }
    },
  };
}
