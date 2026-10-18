import type { ControlPlane } from "@tendworks/shared";
import createClient from "openapi-fetch";
import { describe, expect, it } from "vitest";

type Run = ControlPlane.components["schemas"]["run"];

const client = createClient<ControlPlane.paths>({ baseUrl: process.env.TEND_URL ?? "http://localhost:8080" });

async function waitForEnd(runId: string, timeoutMs = 45_000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await client.GET("/runs/{runId}", { params: { path: { runId } } });
    if (data && (data.status === "completed" || data.status === "failed")) return data;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not end in time (last status: ${data?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe("runs on the compose stack", () => {
  it("starts the example workflow through the API and the fake agent completes it", { timeout: 60_000 }, async () => {
    const { data: started, response } = await client.POST("/runs", {
      body: { workflow: "hello-agent", input: { issue: { number: 6, title: "Start a run" } } },
    });
    expect(response.status).toBe(201);
    expect(started).toMatchObject({ workflow: "hello-agent", input: { issue: { number: 6 } } });

    const run = await waitForEnd(started!.id);

    expect(run).toMatchObject({
      status: "completed",
      steps: [{ name: "implement", reference: "/do/0/implement", status: "completed" }],
      output: { state: "TASK_STATE_COMPLETED", reply: "Pretended to implement the issue." },
    });
    expect(run.steps[0]?.taskId).toBeTruthy();
    const { data: list } = await client.GET("/runs");
    expect(list?.items.map((item) => item.id)).toContain(run.id);
  });

  it("rejects a workflow that is not configured", async () => {
    const { response, error } = await client.POST("/runs", { body: { workflow: "does-not-exist" } });

    expect(response.status).toBe(400);
    expect(error).toMatchObject({ title: "Unknown workflow" });
  });
});
