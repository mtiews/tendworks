import { describe, expect, it } from "vitest";
import { ContractViolation, openApiContract } from "./openapi-contract.js";

// The guard is what keeps the contract tests honest, so it must fail loudly.

const json = (body: unknown, status = 200) => Response.json(body, { status });
const healthy = { status: "healthy", components: [{ name: "store", status: "healthy" }], checkedAt: "2026-10-19T10:00:00.000Z" };

describe("a fetch handler guarded by its OpenAPI contract", () => {
  it("passes a documented exchange and records the response as exercised", async () => {
    const contract = openApiContract("health");
    const fetch = contract.guard(async () => json(healthy));

    const response = await fetch(new Request("http://bundle.test/health"));

    expect(await response.json()).toEqual(healthy);
    expect(contract.unexercised()).toEqual(["GET /health 503"]);
  });

  it("rejects a response body the contract does not allow", async () => {
    const fetch = openApiContract("health").guard(async () => json({ ...healthy, status: "fine" }));

    await expect(fetch(new Request("http://bundle.test/health"))).rejects.toThrow(ContractViolation);
  });

  it("rejects a date-time that is not one", async () => {
    const fetch = openApiContract("health").guard(async () => json({ ...healthy, checkedAt: "yesterday" }));

    await expect(fetch(new Request("http://bundle.test/health"))).rejects.toThrow(/checkedAt/);
  });

  it("rejects a status the operation does not document", async () => {
    const fetch = openApiContract("health").guard(async () => json(healthy, 500));

    await expect(fetch(new Request("http://bundle.test/health"))).rejects.toThrow(/GET \/health answered 500/);
  });

  it("rejects a request for an operation the contract does not have", async () => {
    const fetch = openApiContract("health").guard(async () => json(healthy));

    await expect(fetch(new Request("http://bundle.test/health", { method: "DELETE" }))).rejects.toThrow(/DELETE \/health/);
    await expect(fetch(new Request("http://bundle.test/healthz"))).rejects.toThrow(/GET \/healthz/);
  });

  it("matches templated paths and validates their parameters", async () => {
    const contract = openApiContract("orchestration");
    const fetch = contract.guard(async () => json({ title: "Run not found", status: 404 }, 404));

    await fetch(new Request("http://worker.test/runs/r-1"));

    expect(contract.unexercised()).not.toContain("GET /runs/{runId} 404");
  });

  it("rejects a request the contract forbids when the server accepts it", async () => {
    const run = { id: "r-1", workflow: "w", status: "running", input: {}, steps: [], createdAt: "2026-10-19T10:00:00.000Z" };
    const fetch = openApiContract("control-plane").guard(async () => json(run, 201));

    await expect(
      fetch(new Request("http://tend.test/runs", { method: "POST", body: JSON.stringify({ workflow: 42 }), headers: { "content-type": "application/json" } })),
    ).rejects.toThrow(/request/);
  });

  it("lets the server refuse a request the contract forbids with a documented client error", async () => {
    const fetch = openApiContract("control-plane").guard(async () => json({ title: "Invalid request", status: 400 }, 400));

    const response = await fetch(
      new Request("http://tend.test/runs", { method: "POST", body: JSON.stringify({ workflow: 42 }), headers: { "content-type": "application/json" } }),
    );

    expect(response.status).toBe(400);
  });

  describe("with an event stream", () => {
    const entry = { position: 0, time: "2026-10-19T10:00:00.000Z", type: "message-chunk", text: "Hello" };
    const sse = (text: string, open = false) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            if (!open) controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const stream = new Request("http://worker.test/tasks/t-1/transcript/stream");

    it("hands over a stream that stays open without waiting for its end", async () => {
      const contract = openApiContract("agent-runtime");
      const response = await contract.guard(async () => sse(`id: 0\nevent: entry\ndata: ${JSON.stringify(entry)}\n\n`, true))(stream);
      const reader = response.body!.getReader();

      const first = new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();

      expect(first).toContain('"text":"Hello"');
      expect(contract.unexercised()).not.toContain("GET /tasks/{taskId}/transcript/stream 200");
      expect(contract.violations()).toEqual([]);
    });

    it("records an event of the stream the contract does not allow as it passes", async () => {
      const contract = openApiContract("agent-runtime");
      const response = await contract.guard(async () => sse(`id: 0\nevent: entry\ndata: ${JSON.stringify({ ...entry, type: "acp-update" })}\n\nevent: end\ndata: {}\n\n`))(stream);

      await response.text();

      expect(contract.violations()).toEqual([expect.stringMatching(/GET \/tasks\/\{taskId\}\/transcript\/stream answered 200 with an event/)]);
    });

    it("validates documented header parameters of the request", async () => {
      const contract = openApiContract("agent-runtime");
      const fetch = contract.guard(async () => sse("event: end\ndata: {}\n\n"));

      await expect(fetch(new Request(stream, { headers: { "last-event-id": "soon" } }))).rejects.toThrow(/header parameter Last-Event-ID/);
    });
  });

  it("remembers a violation even when the caller swallows it", async () => {
    const contract = openApiContract("health");
    const fetch = contract.guard(async () => json(healthy, 500));

    await fetch(new Request("http://bundle.test/health")).catch(() => undefined);

    expect(contract.violations()).toEqual([expect.stringMatching(/answered 500/)]);
  });
});
