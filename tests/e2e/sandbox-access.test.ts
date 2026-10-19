import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const field = (text: string, name: string) => new RegExp(`^\\s*${name}:\\s*(\\S+)`, "m").exec(text)?.[1];

// What a sandbox of the developer profile is made of: its template's image, on the
// sandbox network of the compose stack (deploy/compose.yaml, TEND_SANDBOX_NETWORK).
const template = field(read("examples/config/agents/developer.md"), "sandbox");
const image = field(read(`examples/config/sandboxes/${template}.yaml`), "image")!;
const network = field(read("deploy/compose.yaml"), "TEND_SANDBOX_NETWORK")!;
const port = new URL(process.env.TEND_URL ?? "http://localhost:8080").port || "80";

const docker = (...args: string[]) => run("docker", args, { timeout: 120_000 });

/** Runs a script with node in a container from the developer profile's image on the sandbox network. */
async function inDeveloperSandbox(script: string): Promise<string> {
  // The sandbox adapter creates the network on first use; create it the same way if no sandbox ran yet.
  await docker("network", "inspect", network).catch(() =>
    docker("network", "create", "--driver", "bridge", "--opt", "com.docker.network.bridge.enable_icc=false", network),
  );
  const { stdout } = await docker(
    "run",
    "--rm",
    "--network",
    network,
    // Docker Desktop resolves host.docker.internal on its own; on Linux it is the bridge gateway.
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

describe("a sandbox of the developer profile", () => {
  it("cannot read the control plane API: it reaches the published port but holds no token", { timeout: 180_000 }, async () => {
    const answers = await inDeveloperSandbox(`
      const base = "http://host.docker.internal:${port}";
      const status = (path) => fetch(base + path).then((response) => response.status, () => "unreachable");
      Promise.all(["/status", "/runs", "/triggers", "/approval-requests"].map(status)).then((answers) => console.log(JSON.stringify(answers)));
    `);

    // The liveness check answers, so the port is reachable and only the token guards the reads.
    expect(JSON.parse(answers)).toEqual([expect.any(Number), 401, 401, 401]);
  });
});
