import { describe, expect, it } from "vitest";
import { createControlPlaneApi, createFakeMerges, createInMemoryApprovals, createInMemoryRuns } from "./index.js";

const TOKEN = "s3cret-api-token";

function setup() {
  const runs = createInMemoryRuns();
  const merges = createFakeMerges({ refused: { reason: "invalid", title: "Unknown run", detail: "no run 'r-1' exists" } });
  const api = createControlPlaneApi({
    probes: [],
    configuration: { workflowNames: [], workflow: () => undefined, agentProfiles: [], triggerBindings: [], policies: [], pullRequestIntegrations: [] },
    runs,
    merges,
    approvals: createInMemoryApprovals(),
    apiToken: TOKEN,
  });
  const request = async (method: string, path: string, authorization?: string, body: unknown = {}) => {
    const response = await api.fetch(
      new Request(`http://tend.test${path}`, {
        method,
        headers: { "content-type": "application/json", ...(authorization === undefined ? {} : { authorization }) },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, challenge: response.headers.get("www-authenticate"), body: (await response.json()) as unknown };
  };
  return { request, runs, merges };
}

const mutating: [string, string, unknown][] = [
  ["POST", "/runs", { workflow: "build" }],
  ["POST", "/pull-requests/merge", { run: "r-1", pullRequest: null }],
  ["POST", "/approval-requests/a-1/decision", { decision: "approve" }],
];

describe("API token", () => {
  it.each(mutating)("refuses %s %s without the API token, before looking at the request", async (method, path, body) => {
    const { request, runs, merges } = setup();

    for (const authorization of [undefined, "Bearer wrong-token", `Basic ${TOKEN}`, TOKEN]) {
      const answer = await request(method, path, authorization, body);

      expect(answer).toEqual({ status: 401, challenge: "Bearer", body: { title: "Unauthorized", status: 401, detail: "this operation needs the platform's API token as a bearer token" } });
    }
    expect(runs.started).toEqual([]);
    expect(merges.requests).toEqual([]);
  });

  it.each(mutating)("lets %s %s through with the API token", async (method, path, body) => {
    const { request } = setup();

    const { status } = await request(method, path, `Bearer ${TOKEN}`, body);

    expect(status).not.toBe(401);
  });

  it.each(["/status", "/runs", "/triggers", "/approval-requests"])("lets GET %s through without a token", async (path) => {
    const { request } = setup();

    const { status } = await request("GET", path);

    expect(status).not.toBe(401);
  });
});
