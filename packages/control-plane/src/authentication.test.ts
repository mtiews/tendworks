import { describe, expect, it } from "vitest";
import { apiTokenProblems, createControlPlaneApi, createFakeMerges, createInMemoryApprovals, createInMemoryRuns } from "./index.js";

const TOKEN = "s3cret-api-token";
const READ_TOKEN = "s3cret-read-token";

function setup({ readToken = READ_TOKEN }: { readToken?: string | undefined } = {}) {
  const runs = createInMemoryRuns();
  const merges = createFakeMerges({ refused: { reason: "invalid", title: "Unknown run", detail: "no run 'r-1' exists" } });
  const api = createControlPlaneApi({
    probes: [],
    configuration: { workflowNames: [], workflow: () => undefined, agentProfiles: [], triggerBindings: [], policies: [], pullRequestIntegrations: [] },
    runs,
    merges,
    approvals: createInMemoryApprovals(),
    apiToken: TOKEN,
    ...(readToken === undefined ? {} : { readToken }),
  });
  const request = async (method: string, path: string, authorization?: string, body: unknown = {}) => {
    const response = await api.fetch(
      new Request(`http://tend.test${path}`, {
        method,
        headers: { "content-type": "application/json", ...(authorization === undefined ? {} : { authorization }) },
        ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, challenge: response.headers.get("www-authenticate"), body: method === "HEAD" ? undefined : await response.json() };
  };
  return { request, runs, merges };
}

const mutating: [string, string, unknown][] = [
  ["POST", "/runs", { workflow: "build" }],
  ["POST", "/pull-requests/merge", { run: "r-1", pullRequest: null }],
  ["POST", "/approval-requests/a-1/decision", { decision: "approve" }],
  ["POST", "/chats", { agent: "assistant", text: "Hello" }],
  ["POST", "/chats/c-1/messages", { text: "Hello" }],
  ["POST", "/chats/c-1/end", {}],
];

const reading = ["/runs", "/runs/r-1", "/agents", "/triggers", "/notifications", "/approval-requests", "/chats", "/chats/c-1", "/chats/c-1/transcript"];

const wrong = [undefined, "Bearer wrong-token", `Basic ${TOKEN}`, TOKEN, `Bearer ${TOKEN}x`];

describe("API token", () => {
  it.each(mutating)("refuses %s %s without the API token, before looking at the request", async (method, path, body) => {
    const { request, runs, merges } = setup();

    for (const authorization of wrong) {
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

  it.each(mutating)("refuses %s %s with the read-only token, before looking at the request", async (method, path, body) => {
    const { request, runs, merges } = setup();

    const answer = await request(method, path, `Bearer ${READ_TOKEN}`, body);

    expect(answer).toEqual({ status: 403, challenge: null, body: { title: "Forbidden", status: 403, detail: "the read-only token cannot change state; this operation needs the platform's API token" } });
    expect(runs.started).toEqual([]);
    expect(merges.requests).toEqual([]);
  });
});

describe("reading", () => {
  it.each(reading)("refuses GET %s without a token", async (path) => {
    const { request } = setup();

    for (const authorization of [...wrong, `Bearer ${READ_TOKEN}x`]) {
      const answer = await request("GET", path, authorization);

      expect(answer).toEqual({
        status: 401,
        challenge: "Bearer",
        body: { title: "Unauthorized", status: 401, detail: "reading needs the platform's API token or its read-only token as a bearer token" },
      });
    }
  });

  it.each(reading)("refuses HEAD %s without a token, so it tells nothing either", async (path) => {
    const { request } = setup();

    const { status } = await request("HEAD", path);

    expect(status).toBe(401);
  });

  it.each(reading)("serves GET %s with either token", async (path) => {
    const { request } = setup();

    for (const token of [TOKEN, READ_TOKEN]) {
      const { status } = await request("GET", path, `Bearer ${token}`);

      expect(status).not.toBe(401);
    }
  });

  it("serves GET /status without a token, as the liveness check", async () => {
    const { request } = setup();

    const { status } = await request("GET", "/status");

    expect(status).toBe(200);
  });
});

describe("checking the tokens before the server starts", () => {
  const long = "0123456789abcdef";

  it("accepts an API token of at least 16 characters, with or without a different read-only token of at least 16", () => {
    expect(apiTokenProblems({ apiToken: long })).toEqual([]);
    expect(apiTokenProblems({ apiToken: long, readToken: "fedcba9876543210" })).toEqual([]);
  });

  it("refuses tokens that are too short, and a read-only token that is the API token", () => {
    expect(apiTokenProblems({ apiToken: "short" })).toEqual(["TEND_API_TOKEN must be at least 16 characters; generate one with `openssl rand -hex 32`"]);
    expect(apiTokenProblems({ apiToken: long, readToken: "0123456789abcde" })).toEqual([
      "TEND_API_READ_TOKEN must be at least 16 characters; generate one with `openssl rand -hex 32`",
    ]);
    expect(apiTokenProblems({ apiToken: long, readToken: long })).toEqual(["TEND_API_READ_TOKEN must differ from TEND_API_TOKEN, or it could change state"]);
  });

  it("requires the read-only token when an agent profile lists the platform MCP server", () => {
    const profile = (name: string, mcp?: "tendworks"[]) => ({
      apiVersion: "tendworks.dev/v1" as const,
      kind: "AgentProfile" as const,
      metadata: { name },
      spec: { harness: "fake" as const, ...(mcp ? { mcp } : {}) },
    });
    const agentProfiles = [profile("developer"), profile("assistant", ["tendworks"])];

    expect(apiTokenProblems({ apiToken: long, agentProfiles })).toEqual([
      "TEND_API_READ_TOKEN must be set: agent profile assistant lists the platform MCP server (mcp: [tendworks]), which reads with it",
    ]);
    expect(apiTokenProblems({ apiToken: long, readToken: "short", agentProfiles })).toEqual([
      "TEND_API_READ_TOKEN must be at least 16 characters; generate one with `openssl rand -hex 32`",
    ]);
    expect(apiTokenProblems({ apiToken: long, readToken: "fedcba9876543210", agentProfiles })).toEqual([]);
    expect(apiTokenProblems({ apiToken: long, agentProfiles: [profile("developer")] })).toEqual([]);
  });
});

describe("the read-only token", () => {
  it("is optional: without it, reading needs the API token", async () => {
    const { request } = setup({ readToken: undefined });

    expect((await request("GET", "/runs", `Bearer ${TOKEN}`)).status).toBe(200);
    expect((await request("GET", "/runs", "Bearer ")).status).toBe(401);
    expect((await request("GET", "/runs")).status).toBe(401);
  });
});
