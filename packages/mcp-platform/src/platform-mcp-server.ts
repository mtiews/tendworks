import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ControlPlane } from "@tendworks/shared";
import createClient, { type Client } from "openapi-fetch";
import { z } from "zod";

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
      // The control plane decides whether the token may read; a caller it refuses gets nothing,
      // not even the list of tools. Its token check comes before any other answer.
      const { response: probe } = await client.GET("/triggers");
      if (probe.status === 401) return unauthorized();
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
      const { data, response } = await client.GET("/runs");
      return data ? json({ items: data.items.slice(0, limit) }) : failure(response);
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
      const { data, response } = await client.GET("/runs/{runId}", { params: { path: { runId } } });
      return data ? json(data) : failure(response);
    },
  );

  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description:
        "Lists the configured agent profiles with the agent sessions working right now: steps of runs (with run and step) and chats. An agent is running when it has a session.",
      annotations: readOnly,
    },
    async () => {
      const { data, response } = await client.GET("/agents");
      return data ? json(data) : failure(response);
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
      const { data, response } = await client.GET("/triggers");
      return data ? json(data) : failure(response);
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

async function failure(response: Response): Promise<CallToolResult> {
  const problem = (await response.json().catch(() => undefined)) as { title?: string; detail?: string } | undefined;
  const reason = [problem?.title, problem?.detail].filter(Boolean).join(": ") || `HTTP ${response.status}`;
  return { isError: true, content: [{ type: "text", text: `the control plane answered ${response.status}: ${reason}` }] };
}
