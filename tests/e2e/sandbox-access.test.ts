import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { READ_TOKEN } from "./support/control-plane.js";

const run = promisify(execFile);
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const field = (text: string, name: string) => new RegExp(`^\\s*${name}:\\s*(\\S+)`, "m").exec(text)?.[1];

// A sandbox as the compose stack runs it: on its sandbox network (deploy/compose.yaml,
// TEND_SANDBOX_NETWORK). What is checked here is the network and the token, not the
// harness, so the image is the one of the scripted-assistant profile, which `pnpm e2e`
// builds (images/sandbox-scripted-acp); every sandbox image has node.
const template = field(read("examples/config/agents/scripted-assistant.md"), "sandbox");
const image = field(read(`examples/config/sandboxes/${template}.yaml`), "image")!;
const network = field(read("deploy/compose.yaml"), "TEND_SANDBOX_NETWORK")!;
const port = new URL(process.env.TEND_URL ?? "http://localhost:8080").port || "80";

const docker = (...args: string[]) => run("docker", args, { timeout: 120_000 });

/** Runs a script with node in a container on the sandbox network, as the Docker sandbox adapter creates it. */
async function inSandbox(script: string): Promise<string> {
  // The sandbox adapter creates the network on first use; create it the same way if no sandbox ran yet.
  await docker("network", "inspect", network).catch(() =>
    docker("network", "create", "--driver", "bridge", "--opt", "com.docker.network.bridge.enable_icc=false", network),
  );
  const { stdout } = await docker(
    "run",
    "--rm",
    "--network",
    network,
    // The Docker sandbox adapter adds this host to every sandbox, so it resolves on Linux too.
    "--add-host",
    "host.docker.internal:host-gateway",
    "--entrypoint",
    "node",
    image,
    "-e",
    script,
  );
  return stdout.trim();
}

describe("a sandbox", () => {
  it("cannot read the control plane API: it reaches the published port but holds no token", { timeout: 180_000 }, async () => {
    const answers = await inSandbox(`
      const base = "http://host.docker.internal:${port}";
      const status = (path) => fetch(base + path).then((response) => response.status, () => "unreachable");
      Promise.all(["/status", "/runs", "/triggers", "/approval-requests"].map(status)).then((answers) => console.log(JSON.stringify(answers)));
    `);

    // The liveness check answers, so the port is reachable and only the token guards the reads.
    expect(JSON.parse(answers)).toEqual([expect.any(Number), 401, 401, 401]);
  });
});

describe("the platform MCP server", () => {
  // The address compose gives the worker for sessions of profiles that list the server
  // (TEND_PLATFORM_MCP_URL): the server's published port, seen from the sandbox network.
  const mcp = `http://host.docker.internal:${port}/mcp`;

  it("answers a sandbox at its configured address: its tools with the read-only token, nothing without it", { timeout: 180_000 }, async () => {
    const answers = await inSandbox(`
      const call = (token, method, params) =>
        fetch(${JSON.stringify(mcp)}, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: "Bearer " + token } : {}) },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }).then(async (response) => ({ status: response.status, body: response.status === 200 ? await response.json() : undefined }));
      Promise.all([
        call(undefined, "tools/list", {}),
        call(${JSON.stringify(READ_TOKEN)}, "tools/list", {}),
        call(${JSON.stringify(READ_TOKEN)}, "tools/call", { name: "list_agents", arguments: {} }),
      ]).then((answers) => console.log(JSON.stringify(answers)));
    `);

    const [anonymous, tools, agents] = JSON.parse(answers) as { status: number; body?: { result: { tools?: { name: string }[]; content?: { text: string }[] } } }[];
    expect(anonymous?.status).toBe(401);
    expect(tools?.body?.result.tools?.map((tool) => tool.name).sort()).toEqual(["get_run", "list_agents", "list_runs", "list_triggers"]);
    const listed = JSON.parse(agents?.body?.result.content?.[0]?.text ?? "{}") as { items: { name: string }[] };
    expect(listed.items.map((agent) => agent.name)).toContain("assistant");
  });
});
