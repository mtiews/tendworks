import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createAgentRuntimeClient,
  createControlPlaneApi,
  createInMemoryAgentRuntime,
  createInMemoryRuns,
  createInMemoryTriggers,
  loadConfiguration,
  type AgentRuntimePort,
} from "@tendworks/control-plane";
import { createPlatformMcpServer } from "@tendworks/mcp-platform";
import { describe, expect, it } from "vitest";
import { guardedContracts } from "./support/guarded-contracts.js";

/*
 * The platform MCP server (ADR 0016) as a chat agent's harness sees it: an MCP client
 * over Streamable HTTP against the in-process server, which reads the platform through
 * the public control plane API with the token its caller presented.
 */

const contracts = guardedContracts("control-plane");

const API_TOKEN = "contract-test-token";
const READ_TOKEN = "contract-test-read-token";

/** The platform MCP server on a control plane whose agent runtime is `agentRuntime` (in memory by default). */
function platform(agentRuntime: AgentRuntimePort = createInMemoryAgentRuntime()) {
  const configuration = loadConfiguration(fileURLToPath(new URL("../../examples/config", import.meta.url)));
  const runs = createInMemoryRuns();
  const triggers = createInMemoryTriggers([
    { name: "issue-ready-for-agent", workflow: "hello-agent", schedule: { every: { seconds: 10 } }, nextExecutionAt: "2026-10-19T10:00:10.000Z" },
  ]);
  const controlPlane = createControlPlaneApi({ probes: [], configuration, runs, agentRuntime, triggers, apiToken: API_TOKEN, readToken: READ_TOKEN });
  const guarded = contracts["control-plane"].guard((request) => controlPlane.fetch(request));
  const mcp = createPlatformMcpServer({ controlPlane: { baseUrl: "http://tend.test", fetch: guarded } });

  /** An MCP client of the in-process server that presents `token`. */
  async function connect(token?: string): Promise<Client> {
    const client = new Client({ name: "contract-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://tend.test/mcp"), {
      fetch: (url, init) => mcp.fetch(new Request(url, init)),
      requestInit: token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
    });
    // The SDK's transport types predate exactOptionalPropertyTypes; the transport is one.
    await client.connect(transport as Transport);
    return client;
  }

  /** Starts a run through the public API, as the operator would. */
  async function startRun(workflow: string) {
    const response = await guarded(
      new Request("http://tend.test/runs", {
        method: "POST",
        headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ workflow }),
      }),
    );
    return (await response.json()) as { id: string };
  }

  return { connect, startRun, runs };
}

/** The JSON a tool answered with. */
function answer(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  expect(result.isError).toBeFalsy();
  const [content] = result.content as { type: string; text: string }[];
  expect(content?.type).toBe("text");
  return JSON.parse(content!.text);
}

describe("the platform MCP server", () => {
  it("lists trigger bindings with their next scheduled check", async () => {
    const client = await platform().connect(READ_TOKEN);

    const result = await client.callTool({ name: "list_triggers", arguments: {} });

    expect(answer(result)).toEqual({
      items: [{ name: "issue-ready-for-agent", workflow: "hello-agent", schedule: { every: { seconds: 10 } }, nextExecutionAt: "2026-10-19T10:00:10.000Z" }],
    });
  });

  it("lists the runs, newest first", async () => {
    const { connect, startRun } = platform();
    const first = await startRun("hello-agent");
    const second = await startRun("hello-agent");
    const client = await connect(READ_TOKEN);

    const result = answer(await client.callTool({ name: "list_runs", arguments: {} })) as { items: { id: string; workflow: string; status: string }[] };

    expect(result.items.map(({ id, workflow, status }) => ({ id, workflow, status }))).toEqual([
      { id: second.id, workflow: "hello-agent", status: "pending" },
      { id: first.id, workflow: "hello-agent", status: "pending" },
    ]);
  });

  it("lists only as many runs as asked for", async () => {
    const { connect, startRun } = platform();
    await startRun("hello-agent");
    const newest = await startRun("hello-agent");
    const client = await connect(READ_TOKEN);

    const result = answer(await client.callTool({ name: "list_runs", arguments: { limit: 1 } })) as { items: { id: string }[] };

    expect(result.items.map(({ id }) => id)).toEqual([newest.id]);
  });

  it("gets one run with its steps", async () => {
    const { connect, startRun, runs } = platform();
    const started = await startRun("hello-agent");
    runs.runs.get(started.id)!.status = "failed";
    runs.runs.get(started.id)!.error = {
      type: "https://serverlessworkflow.io/spec/1.0.0/errors/runtime",
      status: 500,
      instance: "/do/0/implement",
      title: "the agent failed",
      detail: "the harness ended unexpectedly",
    };
    const client = await connect(READ_TOKEN);

    const result = answer(await client.callTool({ name: "get_run", arguments: { runId: started.id } }));

    expect(result).toMatchObject({ id: started.id, workflow: "hello-agent", status: "failed", error: { title: "the agent failed" }, steps: [] });
  });

  it("answers a run that does not exist with an error the agent can read", async () => {
    const client = await platform().connect(READ_TOKEN);

    const result = await client.callTool({ name: "get_run", arguments: { runId: "no-such-run" } });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(/404/) }]);
  });

  it("lists the agent profiles with the agent sessions working right now", async () => {
    const agentRuntime = createInMemoryAgentRuntime();
    const { connect } = platform(agentRuntime);
    const step = agentRuntime.startStep({ agent: "developer", run: "run-1", step: "implement" });
    const client = await connect(READ_TOKEN);

    const result = answer(await client.callTool({ name: "list_agents", arguments: {} })) as { items: { name: string; sessions: unknown[] }[] };

    expect(result.items.find((agent) => agent.name === "developer")?.sessions).toEqual([
      { kind: "run-step", agent: "developer", taskId: step.taskId, status: "working", startedAt: step.startedAt, run: "run-1", step: "implement" },
    ]);
    expect(result.items.find((agent) => agent.name === "assistant")?.sessions).toEqual([]);
  });

  it("lists the agent profiles without sessions while the agent runtime cannot be reached", async () => {
    const unreachable = createAgentRuntimeClient({
      baseUrl: "http://worker.test",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const client = await platform(unreachable).connect(READ_TOKEN);

    const result = answer(await client.callTool({ name: "list_agents", arguments: {} })) as { items: { name: string; sessions?: unknown[] }[] };

    expect(result.items.map((agent) => agent.name)).toContain("developer");
    expect(result.items.filter((agent) => agent.sessions !== undefined)).toEqual([]);
  });

  it("offers only the four tools, all of them read-only", async () => {
    const client = await platform().connect(READ_TOKEN);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(["get_run", "list_agents", "list_runs", "list_triggers"]);
    for (const tool of tools) expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it.each([
    ["no token", undefined],
    ["a wrong token", "not-a-token-of-this-platform"],
  ])("serves nothing to a caller with %s", async (_, token) => {
    const { connect } = platform();

    await expect(connect(token)).rejects.toMatchObject({ code: 401 });
  });
});
