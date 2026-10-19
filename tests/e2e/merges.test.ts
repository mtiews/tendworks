import type { ControlPlane } from "@tendworks/shared";
import createClient from "openapi-fetch";
import { describe, expect, it } from "vitest";

type Run = ControlPlane.components["schemas"]["run"];

const client = createClient<ControlPlane.paths>({ baseUrl: process.env.TEND_URL ?? "http://localhost:8080" });

async function runToEnd(workflow: string, timeoutMs = 45_000): Promise<Run> {
  const { data: started, response } = await client.POST("/runs", { body: { workflow, input: { issue: { number: 14, title: "Merge it" } } } });
  expect(response.status).toBe(201);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await client.GET("/runs/{runId}", { params: { path: { runId: started!.id } } });
    if (data && (data.status === "completed" || data.status === "failed")) return data;
    if (Date.now() > deadline) throw new Error(`run ${started!.id} did not end in time (last status: ${data?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// Fakes only: the fake agent reports a pull request on the reserved git.example host, which
// the server merges in the configured fake pull request integration behind the example policy
// merge-gate (merge: auto). No real repository is touched.
describe("merge step on the compose stack", () => {
  it("merges the pull request the agent reported, as a platform step, and completes the run", { timeout: 60_000 }, async () => {
    const run = await runToEnd("fake-develop-and-merge");

    expect(run).toMatchObject({
      status: "completed",
      steps: [
        { name: "implement", reference: "/do/0/implement", status: "completed" },
        { name: "merge", reference: "/do/1/merge", status: "completed" },
        { name: "merged", reference: "/do/2/merged", status: "completed" },
      ],
      output: { pullRequest: "https://git.example/example/playground/pull/1", merged: true, decision: "allow" },
    });
  });

  it("fails the merge step with a readable error when the agent reported no pull request", { timeout: 60_000 }, async () => {
    const run = await runToEnd("fake-develop-without-pull-request");

    expect(run).toMatchObject({
      status: "failed",
      error: { instance: "/do/1/merge", status: 400, title: "No pull request to merge" },
      steps: [{ name: "implement", status: "completed" }, { name: "merge", status: "failed" }],
    });
    expect(run.error?.detail).toContain("reported no pull request");
  });

  it("refuses a merge request for a run that does not exist, and one that picks its own policy", async () => {
    const unknown = await client.POST("/pull-requests/merge", { body: { run: "no-such-run", pullRequest: "https://git.example/example/playground/pull/2" } });
    const chosen = await client.POST("/pull-requests/merge", {
      body: { run: "no-such-run", pullRequest: "https://git.example/example/playground/pull/2", policy: "merge-gate" } as never,
    });

    expect(unknown.response.status).toBe(400);
    expect(unknown.error).toMatchObject({ title: "Unknown run" });
    expect(chosen.response.status).toBe(400);
    expect(chosen.error).toMatchObject({ title: "Invalid request" });
  });
});
