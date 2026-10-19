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

// Fakes only: the fake agent reports a pull request on a reserved .example host, which
// the server merges in its fake pull request integration behind the example policy
// merge-gate (merge: auto). No real repository is touched.
describe("merge step on the compose stack", () => {
  it("merges the pull request the agent reported, as a platform step, and completes the run", { timeout: 60_000 }, async () => {
    const run = await runToEnd("fake-develop-and-merge");

    expect(run).toMatchObject({
      status: "completed",
      steps: [
        { name: "implement", reference: "/do/0/implement", status: "completed" },
        { name: "merge", reference: "/do/1/merge", status: "completed" },
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

  it("refuses a merge request for a policy that is not configured", async () => {
    const { response, error } = await client.POST("/pull-requests/merge", {
      body: { pullRequest: "https://git.example/example/playground/pull/2", policy: "no-such-policy" },
    });

    expect(response.status).toBe(400);
    expect(error).toMatchObject({ title: "Unknown policy", detail: expect.stringContaining("merge-gate") });
  });
});
