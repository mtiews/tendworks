import { describe, expect, it } from "vitest";
import { createControlPlaneApi, createInMemoryRuns, createTriggerGatewayClient, emptyConfiguration, type Trigger } from "./index.js";

const trigger: Trigger = {
  name: "ready-issues",
  workflow: "implement-issue",
  kind: "schedule",
  workspaces: ["app"],
  schedule: { every: { minutes: 5 } },
  nextExecutionAt: "2026-10-18T10:05:00.000Z",
};

function api(gateway: (request: Request) => Promise<Response>) {
  return createControlPlaneApi({
    probes: [],
    configuration: emptyConfiguration(),
    apiToken: "test-token",
    readToken: "test-read-token",
    runs: createInMemoryRuns(),
    triggers: createTriggerGatewayClient({ baseUrl: "http://trigger-gateway.test", fetch: gateway }),
  });
}

describe("triggers API", () => {
  it("lists the triggers the trigger gateway reports", async () => {
    const asked: string[] = [];
    const controlPlane = api(async (request) => {
      asked.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ items: [trigger] });
    });

    const response = await controlPlane.fetch(new Request("http://tend.test/triggers", { headers: { authorization: "Bearer test-token" } }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [trigger] });
    expect(asked).toEqual(["GET /triggers"]);
  });

  it("answers 503 when the trigger gateway cannot be reached", async () => {
    const controlPlane = api(() => Promise.reject(new Error("connect ECONNREFUSED")));

    const response = await controlPlane.fetch(new Request("http://tend.test/triggers", { headers: { authorization: "Bearer test-token" } }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ title: "Trigger gateway unavailable", status: 503, detail: "connect ECONNREFUSED" });
  });
});

describe("firing a trigger binding through the API", () => {
  const fire = (controlPlane: ReturnType<typeof api>, name: string, options: { token?: string; body?: string } = {}) =>
    controlPlane.fetch(
      new Request(`http://tend.test/triggers/${name}/fire`, {
        method: "POST",
        headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
        ...(options.body === undefined ? {} : { body: options.body }),
      }),
    );

  it("forwards the firing to the trigger gateway and answers 201 with the started runs", async () => {
    const asked: { call: string; body: unknown }[] = [];
    const controlPlane = api(async (request) => {
      asked.push({ call: `${request.method} ${new URL(request.url).pathname}`, body: await request.json() });
      return Response.json({ items: [{ workspace: "web", runId: "r-1" }] }, { status: 201 });
    });

    const narrowed = await fire(controlPlane, "architecture-review", { token: "test-token", body: JSON.stringify({ workspace: "web" }) });
    const all = await fire(controlPlane, "architecture-review", { token: "test-token" });

    expect(narrowed.status).toBe(201);
    expect(await narrowed.json()).toEqual({ items: [{ workspace: "web", runId: "r-1" }] });
    expect(all.status).toBe(201);
    expect(asked).toEqual([
      { call: "POST /triggers/architecture-review/fire", body: { workspace: "web" } },
      { call: "POST /triggers/architecture-review/fire", body: {} },
    ]);
  });

  it("needs the API token: 401 without a token, 403 with the read-only token", async () => {
    const asked: string[] = [];
    const controlPlane = api(async (request) => {
      asked.push(request.url);
      return Response.json({ items: [] }, { status: 201 });
    });

    const without = await fire(controlPlane, "architecture-review");
    const readOnly = await fire(controlPlane, "architecture-review", { token: "test-read-token" });

    expect(without.status).toBe(401);
    expect(without.headers.get("www-authenticate")).toBe("Bearer");
    expect(readOnly.status).toBe(403);
    expect(asked).toEqual([]);
  });

  it("answers the trigger gateway's refusals with its status: 404, 409 and 400", async () => {
    const refusals = [
      { title: "Trigger binding not found", status: 404, detail: "no trigger binding 'nightly'" },
      { title: "Trigger binding not fireable", status: 409, detail: "trigger binding 'nightly' is suspended" },
      { title: "Invalid request", status: 400, detail: "trigger binding 'nightly' does not start runs in workspace 'mobile' (workspaces: app)" },
    ];
    for (const refusal of refusals) {
      const controlPlane = api(async () => Response.json(refusal, { status: refusal.status }));

      const response = await fire(controlPlane, "nightly", { token: "test-token" });

      expect(response.status).toBe(refusal.status);
      expect(await response.json()).toEqual(refusal);
    }
  });

  it("refuses a malformed body with 400 without asking the trigger gateway", async () => {
    const asked: string[] = [];
    const controlPlane = api(async (request) => {
      asked.push(request.url);
      return Response.json({ items: [] }, { status: 201 });
    });

    const answers = await Promise.all([
      fire(controlPlane, "architecture-review", { token: "test-token", body: "{" }),
      fire(controlPlane, "architecture-review", { token: "test-token", body: JSON.stringify({ workspace: 7 }) }),
      fire(controlPlane, "architecture-review", { token: "test-token", body: JSON.stringify(["web"]) }),
    ]);

    expect(answers.map((answer) => answer.status)).toEqual([400, 400, 400]);
    expect(asked).toEqual([]);
  });

  it("answers 503 when the trigger gateway cannot be reached", async () => {
    const controlPlane = api(() => Promise.reject(new Error("connect ECONNREFUSED")));

    const response = await fire(controlPlane, "architecture-review", { token: "test-token" });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ title: "Trigger gateway unavailable", status: 503, detail: "connect ECONNREFUSED" });
  });
});
