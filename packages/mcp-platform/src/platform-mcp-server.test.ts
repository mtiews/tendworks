import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";
import { createPlatformMcpServer } from "./platform-mcp-server.js";
import type { TranscriptEntry } from "./transcript-excerpt.js";

const time = "2026-10-19T10:00:00.000Z";
const entries: TranscriptEntry[] = Array.from({ length: 70 }, (_, position) => ({ position, time, type: "message-chunk", text: `chunk ${position}` }));

/**
 * An MCP client of the server on a fake control plane that knows run `run-1` with task
 * `task-1` and records the requests it is sent.
 */
async function connect() {
  const requests: Request[] = [];
  const server = createPlatformMcpServer({
    controlPlane: {
      baseUrl: "http://tend.test",
      fetch: async (request) => {
        requests.push(request);
        const path = new URL(request.url).pathname;
        if (path === "/triggers") return Response.json({ items: [] });
        if (path === "/runs/run-1/tasks/task-1/transcript") return Response.json({ items: entries });
        return Response.json({ type: "about:blank", status: 404, title: "Run not found" }, { status: 404, headers: { "content-type": "application/problem+json" } });
      },
    },
  });
  const client = new Client({ name: "unit-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://tend.test/mcp"), {
    fetch: (url, init) => server.fetch(new Request(url, init)),
    requestInit: { headers: { authorization: "Bearer read-token" } },
  });
  await client.connect(transport as Transport);
  return { client, requests };
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { text: string }[])[0]!.text;

describe("get_run_transcript", () => {
  it("reads the transcript with the caller's token and answers its newest 50 entries", async () => {
    const { client, requests } = await connect();

    const result = await client.callTool({ name: "get_run_transcript", arguments: { runId: "run-1", taskId: "task-1" } });

    expect(JSON.parse(text(result))).toEqual({ total: 70, omitted: 20, items: entries.slice(20) });
    const read = requests.find((request) => new URL(request.url).pathname.endsWith("/transcript"));
    expect(read?.headers.get("authorization")).toBe("Bearer read-token");
  });

  it("answers an unknown run with an error naming the control plane's reason", async () => {
    const { client } = await connect();

    const result = await client.callTool({ name: "get_run_transcript", arguments: { runId: "run-9", taskId: "task-1" } });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("the control plane answered 404: Run not found");
  });

  it("refuses a limit beyond what fits an agent's context", async () => {
    const { client } = await connect();

    const result = await client.callTool({ name: "get_run_transcript", arguments: { runId: "run-1", taskId: "task-1", last: 501 } });

    expect(result.isError).toBe(true);
  });
});
