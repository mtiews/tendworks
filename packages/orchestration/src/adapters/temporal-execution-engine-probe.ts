import { Connection } from "@temporalio/client";

/** Checks that the durable execution engine answers. Shape matches the control plane's health probe. */
export function createExecutionEngineProbe(address: string) {
  return {
    name: "execution-engine",
    async check(): Promise<{ status: "healthy" }> {
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
