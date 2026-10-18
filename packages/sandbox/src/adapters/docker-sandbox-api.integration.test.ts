import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll } from "vitest";
import { createDockerSandboxApi } from "../index.js";
import { describeSandboxApi } from "../sandbox-api.suite.js";

/*
 * Runs the shared suite against real Docker, reached only through the socket
 * proxy configured exactly as in deploy/compose.yaml. Every container this file
 * starts carries a run label and is removed afterwards.
 */

const run = promisify(execFile);
const docker = async (...args: string[]) => (await run("docker", args, { env: { ...process.env, MSYS_NO_PATHCONV: "1" } })).stdout.trim();

const image = "busybox:1.37.0";
const composeFile = fileURLToPath(new URL("../../../../deploy/compose.yaml", import.meta.url));
const runLabel = `dev.tendworks.test-run=${crypto.randomUUID()}`;
let proxyUrl: string;

async function startSocketProxy(): Promise<string> {
  const config = JSON.parse(await docker("compose", "-f", composeFile, "config", "--format", "json"));
  const proxy = config.services["docker-proxy"] as { image: string; environment: Record<string, string> };
  const env = Object.entries(proxy.environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const id = await docker(
    "run", "-d", "--rm", "--label", runLabel, "-p", "127.0.0.1::2375",
    "-v", "/var/run/docker.sock:/var/run/docker.sock:ro", ...env, proxy.image,
  );
  const address = (await docker("port", id, "2375/tcp")).split("\n")[0]!;
  const url = `http://${address}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(new URL("/_ping", url))).ok) return url;
    } catch {
      // proxy still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`socket proxy at ${url} did not become ready`);
}

beforeAll(async () => {
  await docker("pull", "-q", image);
  proxyUrl = await startSocketProxy();
});

afterAll(async () => {
  const leftovers = await docker("ps", "-aq", "--filter", `label=${runLabel}`);
  if (leftovers) await docker("rm", "-f", "-v", ...leftovers.split(/\s+/));
});

describeSandboxApi("Docker adapter through the socket proxy", () => ({
  api: createDockerSandboxApi({ url: proxyUrl, labels: { [runLabel.split("=")[0]!]: runLabel.split("=")[1]! } }),
  image,
}));
