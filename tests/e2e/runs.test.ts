import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { anonymous, client, reader } from "./support/control-plane.js";

type Run = ControlPlane.components["schemas"]["run"];

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
      body: { workflow: "hello-agent", input: { item: { key: "start", title: "Start a run", number: 6 } } },
    });
    expect(response.status).toBe(201);
    expect(started).toMatchObject({ workflow: "hello-agent", input: { item: { number: 6 } } });

    const run = await waitForEnd(started!.id);

    expect(run).toMatchObject({
      status: "completed",
      steps: [{ name: "implement", reference: "/do/0/implement", status: "completed" }],
      output: { state: "TASK_STATE_COMPLETED", reply: "Pretended to implement the issue." },
    });
    expect(run.steps[0]?.taskId).toBeTruthy();
    // The agent runtime keeps the session's transcript on its own volume and reports the cost.
    expect(run.steps[0]?.transcript).toBe(`file:///var/lib/tendworks/transcripts/${run.steps[0]?.taskId}.jsonl`);
    expect(run.steps[0]?.cost).toEqual({ amount: 0, currency: "USD" });
    const { data: list } = await client.GET("/runs");
    expect(list?.items.map((item) => item.id)).toContain(run.id);
  });

  it("fails a run whose workflow raises an error because the agent reported no pull request", { timeout: 60_000 }, async () => {
    const { data: started } = await client.POST("/runs", {
      body: { workflow: "requires-pull-request", input: { item: { key: "raise", title: "Report nothing", number: 12 } } },
    });
    expect(started).toBeDefined();

    const run = await waitForEnd(started!.id);

    const error = {
      type: "https://serverlessworkflow.io/spec/1.0.0/errors/runtime",
      status: 500,
      instance: "/do/2/fail",
      title: "The agent ended without reporting its result",
      detail: "no pull request; last answer: Pretended to implement the issue.",
    };
    expect(run).toMatchObject({ status: "failed", error });
    expect(run.steps.map((step) => [step.name, step.status])).toEqual([
      ["implement", "completed"],
      ["check", "completed"],
      ["fail", "failed"],
    ]);
    expect(run.steps[2]?.error).toEqual(error);
  });

  it("retries a failed run with its input and origin, and the retry fails again", { timeout: 90_000 }, async () => {
    const input = { item: { key: "retry", title: "Report nothing again", number: 13 } };
    const { data: started } = await client.POST("/runs", { body: { workflow: "requires-pull-request", input } });
    const failed = await waitForEnd(started!.id);
    expect(failed.status).toBe("failed");

    const { data: retry, response } = await client.POST("/runs/{runId}/retry", { params: { path: { runId: failed.id } } });
    const refused = await client.POST("/runs/{runId}/retry", { params: { path: { runId: retry!.id } } });

    expect(response.status).toBe(201);
    expect(retry).toMatchObject({ workflow: "requires-pull-request", input, startedBy: { kind: "manual", retryOf: failed.id } });
    // Not failed yet: a run is retried only once it failed.
    expect(refused.response.status).toBe(409);
    expect(await waitForEnd(retry!.id)).toMatchObject({ status: "failed", error: { title: "The agent ended without reporting its result" }, startedBy: { retryOf: failed.id } });
  });

  it("neither starts nor lists runs without a token, and lets the read-only token only read", async () => {
    const { response } = await anonymous.POST("/runs", { body: { workflow: "hello-agent" } });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect((await anonymous.GET("/runs")).response.status).toBe(401);
    expect((await anonymous.GET("/status")).response.status).toBe(200);
    expect((await reader.GET("/runs")).response.status).toBe(200);
    expect((await reader.POST("/runs", { body: { workflow: "hello-agent" } })).response.status).toBe(403);
  });

  it("rejects a workflow that is not configured", async () => {
    const { response, error } = await client.POST("/runs", { body: { workflow: "does-not-exist" } });

    expect(response.status).toBe(400);
    expect(error).toMatchObject({ title: "Unknown workflow" });
  });
});
