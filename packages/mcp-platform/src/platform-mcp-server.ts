import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ControlPlane } from "@tendworks/shared";
import createClient, { type Client } from "openapi-fetch";
import { z } from "zod";
import { excerpt } from "./transcript-excerpt.js";

export interface PlatformMcpServerOptions {
  /** The public control plane API the tools read through, like any other client. */
  controlPlane: { baseUrl: string; fetch?: (request: Request) => Promise<Response> };
}

type ControlPlaneClient = Client<ControlPlane.paths>;

/**
 * The platform MCP server (ADR 0016): tools a chat agent uses to read the platform's live
 * state. It is a client of the public control plane API with the bearer token its caller
 * presented, so it can read exactly what that token may read and change nothing.
 */
export function createPlatformMcpServer({ controlPlane }: PlatformMcpServerOptions): { fetch(request: Request): Promise<Response> } {
  return {
    async fetch(request) {
      const token = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (token === undefined) return unauthorized();
      const client = createClient<ControlPlane.paths>({
        baseUrl: controlPlane.baseUrl,
        headers: { authorization: `Bearer ${token}` },
        ...(controlPlane.fetch ? { fetch: controlPlane.fetch } : {}),
      });
      if (!(await authorize(client))) return unauthorized();
      // Stateless (no session id generator): every request gets its own server and transport,
      // which answers with JSON and is closed once the answer is complete.
      const server = toolsOn(client);
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        await server.close();
      }
    },
  };
}

/**
 * Whether the control plane accepts the caller's token for reading. The control plane, not
 * this server, decides who may read (ADR 0016), and a caller it refuses gets nothing, not even
 * the list of tools; so every request (the server is stateless) asks it first. It has no
 * endpoint that only checks a token, so this reads `GET /triggers`: it needs a token, and it
 * is the cheapest reading operation, answered in the server process from the configuration and
 * one small query, without the worker. The token check comes before any other answer, so a
 * failure other than 401 (e.g. 503) still means the token was accepted.
 */
async function authorize(client: ControlPlaneClient): Promise<boolean> {
  const { response } = await client.GET("/triggers");
  return response.status !== 401;
}

function toolsOn(client: ControlPlaneClient): McpServer {
  const server = new McpServer({ name: "tendworks", version: "0.1.0" });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool(
    "list_runs",
    {
      title: "List runs",
      description:
        "Lists the platform's runs, newest first: the workflow, status, what started the run, its steps with their agents, tasks and costs, and why a run or step failed.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional().describe("How many of the newest runs to list; 20 when not given.") },
      annotations: readOnly,
    },
    async ({ limit = 20 }) => {
      const { data, error, response } = await client.GET("/runs");
      return data ? json({ items: data.items.slice(0, limit) }) : failure(response, error);
    },
  );

  server.registerTool(
    "get_run",
    {
      title: "Get a run",
      description: "Gets one run by its id with all its steps, their status, agent tasks, costs and errors.",
      inputSchema: { runId: z.string().min(1).describe("The run's id, as list_runs shows it.") },
      annotations: readOnly,
    },
    async ({ runId }) => {
      const { data, error, response } = await client.GET("/runs/{runId}", { params: { path: { runId } } });
      return data ? json(data) : failure(response, error);
    },
  );

  server.registerTool(
    "get_run_transcript",
    {
      title: "Get the transcript of a run's step",
      description:
        "Reads the transcript of the agent session behind one step of a run: what the agent was asked, what it wrote and thought, the tools it called with their results, and the errors, with secrets redacted. Find the step's taskId with get_run first. Answers the newest entries only, with how many the transcript has in total and how many were left out; ask for only the problems (errors, failed tool calls with their call, harness output, a failed checkout or task) to see why a step failed.",
      inputSchema: {
        runId: z.string().min(1).describe("The run's id, as list_runs shows it."),
        taskId: z.string().min(1).describe("The taskId of the run's step, as get_run shows it."),
        last: z.number().int().min(1).max(500).optional().describe("How many of the newest entries to read; 50 when not given."),
        only: z.enum(["problems"]).optional().describe("`problems` reads only the entries that tell what went wrong."),
      },
      annotations: readOnly,
    },
    async ({ runId, taskId, last = 50, only }) => {
      const { data, error, response } = await client.GET("/runs/{runId}/tasks/{taskId}/transcript", { params: { path: { runId, taskId } } });
      return data ? json(excerpt(data.items, { last, only })) : failure(response, error);
    },
  );

  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description:
        "Lists the configured agent profiles with the agent sessions working right now: steps of runs (with run and step) and chats. An agent is running when it has a session; a profile without `sessions` means the platform cannot tell right now.",
      annotations: readOnly,
    },
    async () => {
      const { data, error, response } = await client.GET("/agents");
      return data ? json(data) : failure(response, error);
    },
  );

  server.registerTool(
    "list_triggers",
    {
      title: "List trigger bindings",
      description: "Lists the platform's trigger bindings: the workflow each starts, its schedule, when it next checks its source, and how its last check went.",
      annotations: readOnly,
    },
    async () => {
      const { data, error, response } = await client.GET("/triggers");
      return data ? json(data) : failure(response, error);
    },
  );

  return server;
}

const unauthorized = () =>
  Response.json(
    { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: present the platform's read-only token as a bearer token" }, id: null },
    { status: 401, headers: { "www-authenticate": "Bearer" } },
  );

const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

/** A tool's answer to a refusal of the control plane, with the reason its problem gives. */
function failure(response: Response, error: unknown): CallToolResult {
  const problem = typeof error === "object" && error !== null ? (error as { title?: unknown; detail?: unknown }) : {};
  const reason = [problem.title, problem.detail].filter((part) => typeof part === "string" && part !== "").join(": ") || `HTTP ${response.status}`;
  return { isError: true, content: [{ type: "text", text: `the control plane answered ${response.status}: ${reason}` }] };
}
