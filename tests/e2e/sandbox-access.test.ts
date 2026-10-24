import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { READ_TOKEN } from "./support/control-plane.js";
import { platformMcpNetwork, sandboxNetwork } from "./support/installation.js";

const run = promisify(execFile);
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const field = (text: string, name: string) => new RegExp(`^\\s*${name}:\\s*(\\S+)`, "m").exec(text)?.[1];

// A sandbox as the compose stack runs it: on its installation's sandbox network
// (<installation>-sandboxes). What is checked here is the network and the token, not the
// harness, so the image is the one of the scripted-assistant profile, which `pnpm e2e`
// builds (images/sandbox-scripted-acp); every sandbox image has node.
const template = field(read("tests/fixtures/config/agents/scripted-assistant.md"), "sandbox");
const image = field(read(`tests/fixtures/config/sandboxes/${template}.yaml`), "image")!;
const network = sandboxNetwork;
const port = new URL(process.env.TEND_URL ?? "http://localhost:8080").port || "80";

const docker = (...args: string[]) => run("docker", args, { timeout: 120_000 });

/**
 * Runs a script with node in a container on the sandbox network, as the Docker sandbox
 * adapter creates it; with `platformMcp`, also on the MCP-only gateway's network, as the
 * adapter creates sandboxes of profiles that list the platform MCP server.
 */
async function inSandbox(script: string, { platformMcp = false } = {}): Promise<string> {
  // The sandbox adapter creates the network on first use; create it the same way if no sandbox ran yet.
  await docker("network", "inspect", network).catch(() =>
    docker("network", "create", "--driver", "bridge", "--opt", "com.docker.network.bridge.enable_icc=false", network),
  );
  const { stdout: id } = await docker(
    "create",
    "--network",
    network,
    // Docker Desktop resolves host.docker.internal on its own; on Linux it is the bridge
    // gateway, which does not reach the port compose publishes on 127.0.0.1 only.
    "--add-host",
    "host.docker.internal:host-gateway",
    "--entrypoint",
    "node",
    image,
    "-e",
    script,
  );
  const container = id.trim();
  try {
    if (platformMcp) await docker("network", "connect", platformMcpNetwork, container);
    const { stdout } = await docker("start", "--attach", container);
    return stdout.trim();
  } finally {
    await docker("rm", "-f", container);
  }
}

/** Whether a sandbox reaches the published port at all: on Docker Desktop it does, on Linux it does not. */
let reachable: Promise<boolean> | undefined;
const publishedPortReachable = () =>
  (reachable ??= inSandbox(`
    fetch("http://host.docker.internal:${port}/status").then(() => console.log("yes"), () => console.log("no"));
  `).then((answer) => answer === "yes"));

describe("a sandbox", () => {
  it("cannot read the control plane API: where it reaches the published port, it holds no token", { timeout: 180_000 }, async () => {
    const answers = await inSandbox(`
      const base = "http://host.docker.internal:${port}";
      const status = (path) => fetch(base + path).then((response) => response.status, () => "unreachable");
      Promise.all(["/status", "/runs", "/triggers", "/approval-requests"].map(status)).then((answers) => console.log(JSON.stringify(answers)));
    `);

    // Where the liveness check answers, the port is reachable and only the token guards the reads.
    const expected = (await publishedPortReachable()) ? [expect.any(Number), 401, 401, 401] : ["unreachable", "unreachable", "unreachable", "unreachable"];
    expect(JSON.parse(answers)).toEqual(expected);
  });
});

/** A script that asks each path for its status with the given token, "unreachable" where no answer comes. */
const statuses = (base: string, paths: string[], token?: string) => `
  const status = (path) =>
    fetch(${JSON.stringify(base)} + path, { signal: AbortSignal.timeout(5000), ${token ? `headers: { authorization: "Bearer ${token}" }` : ""} })
      .then((response) => response.status, () => "unreachable");
  Promise.all(${JSON.stringify(paths)}.map(status)).then((answers) => console.log(JSON.stringify(answers)));
`;

describe("the platform MCP server", () => {
  // The address compose gives the worker for sessions of profiles that list the server
  // (TEND_PLATFORM_MCP_URL): the MCP-only gateway, on its network (ADR 0019).
  const gateway = "http://mcp-gateway:8080";

  it("answers a sandbox on the gateway's network: its tools with the read-only token, nothing without it", { timeout: 180_000 }, async () => {
    const answers = await inSandbox(
      `
      const call = (token, method, params) =>
        fetch("${gateway}/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: "Bearer " + token } : {}) },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }).then(async (response) => ({ status: response.status, body: response.status === 200 ? await response.json() : undefined }));
      Promise.all([
        call(undefined, "tools/list", {}),
        call(${JSON.stringify(READ_TOKEN)}, "tools/list", {}),
        call(${JSON.stringify(READ_TOKEN)}, "tools/call", { name: "list_agents", arguments: {} }),
      ]).then((answers) => console.log(JSON.stringify(answers)));
    `,
      { platformMcp: true },
    );

    const [anonymous, tools, agents] = JSON.parse(answers) as { status: number; body?: { result: { tools?: { name: string }[]; content?: { text: string }[] } } }[];
    expect(anonymous?.status).toBe(401);
    expect(tools?.body?.result.tools?.map((tool) => tool.name).sort()).toEqual(["get_run", "list_agents", "list_runs", "list_triggers"]);
    const listed = JSON.parse(agents?.body?.result.content?.[0]?.text ?? "{}") as { items: { name: string }[] };
    expect(listed.items.map((agent) => agent.name)).toContain("assistant");
  });

  it("is all a sandbox on the gateway's network reaches of the API, even with the read-only token", { timeout: 180_000 }, async () => {
    const paths = ["/runs", "/status", "/triggers", "/chats", "/mcpx", "/mcp/runs", "/"];

    const answers = await inSandbox(statuses(gateway, paths, READ_TOKEN), { platformMcp: true });
    const server = await inSandbox(statuses("http://server:8080", ["/status", "/mcp"]), { platformMcp: true });

    expect(JSON.parse(answers)).toEqual(paths.map(() => 404));
    expect(JSON.parse(server)).toEqual(["unreachable", "unreachable"]);
  });

  it("is out of reach of a sandbox of a profile that does not list it, as is the server", { timeout: 180_000 }, async () => {
    const answers = await inSandbox(statuses(gateway, ["/mcp", "/runs"]));
    const server = await inSandbox(statuses("http://server:8080", ["/status", "/mcp"]));

    expect(JSON.parse(answers)).toEqual(["unreachable", "unreachable"]);
    expect(JSON.parse(server)).toEqual(["unreachable", "unreachable"]);
  });
});
