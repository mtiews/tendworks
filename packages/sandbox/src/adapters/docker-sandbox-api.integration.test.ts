import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerSandboxApi, type SandboxApi, type SandboxTemplate } from "../index.js";
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
  const volumes = await docker("volume", "ls", "-q", "--filter", `label=${runLabel}`);
  if (volumes) await docker("volume", "rm", "-f", ...volumes.split(/\s+/));
});

const createApi = () => createDockerSandboxApi({ url: proxyUrl, labels: { [runLabel.split("=")[0]!]: runLabel.split("=")[1]! } });

describeSandboxApi("Docker adapter through the socket proxy", () => ({ api: createApi(), image }));

describe.concurrent("Docker adapter", () => {
  const created: string[] = [];
  let api: SandboxApi;

  beforeAll(() => {
    api = createApi();
  });

  afterAll(async () => {
    await Promise.all(created.map((id) => api.destroy(id)));
  });

  const template = (spec: Partial<SandboxTemplate["spec"]> = {}): SandboxTemplate => ({
    apiVersion: "tendworks.dev/v1",
    kind: "SandboxTemplate",
    metadata: { name: "docker-only" },
    spec: { image, ...spec },
  });

  const create = async (t = template()) => {
    const sandbox = await api.create(t);
    created.push(sandbox.id);
    return sandbox;
  };

  const sh = async (id: string, script: string) => (await api.exec(id, { command: ["sh", "-c", script] })).stdout;

  it("runs sandboxes without capabilities, without privilege escalation and under seccomp", async () => {
    const { id } = await create();

    const status = await sh(id, "grep -E '^(CapEff|CapPrm|NoNewPrivs|Seccomp):' /proc/self/status");

    expect(status).toMatch(/^CapPrm:\s+0{16}$/m);
    expect(status).toMatch(/^CapEff:\s+0{16}$/m);
    expect(status).toMatch(/^NoNewPrivs:\s+1$/m);
    expect(status).toMatch(/^Seccomp:\s+2$/m);
  });

  it("hands written files to the sandbox user", async () => {
    const { id } = await create(template({ user: "4242:4343" }));

    await api.writeFile(id, "/tmp/owned/file.txt", new TextEncoder().encode("x"));

    expect(await sh(id, "stat -c %u:%g /tmp/owned/file.txt /tmp/owned")).toBe("4242:4343\n4242:4343\n");
  });

  it("applies the template's resource limits", async () => {
    const { id } = await create(template({ resources: { memoryMb: 128, pids: 64, cpus: 0.5 } }));

    expect(await sh(id, "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max /sys/fs/cgroup/cpu.max")).toBe(
      `${128 * 1024 * 1024}\n64\n50000 100000\n`,
    );
  });

  it("rejects a template whose image is not on the host", async () => {
    await expect(api.create(template({ image: "tendworks.invalid/not-pulled:0.0.0" }))).rejects.toMatchObject({ code: "image-not-found" });
  });

  it("maps isolation class gvisor to the gVisor runtime", async () => {
    const runtimes = JSON.parse(await docker("info", "--format", "{{json .Runtimes}}")) as Record<string, unknown>;

    if ("runsc" in runtimes) {
      const { id, isolationClass } = await create(template({ isolationClass: "gvisor" }));
      expect(isolationClass).toBe("gvisor");
      expect(await sh(id, "dmesg 2>/dev/null | head -n 1")).toContain("gVisor");
    } else {
      await expect(api.create(template({ isolationClass: "gvisor" }))).rejects.toMatchObject({
        code: "isolation-class-unavailable",
        message: expect.stringContaining("runsc"),
      });
    }
  });
});

describe("socket proxy", () => {
  it.each(["/images/json", "/info", "/events", "/networks", "/system/df"])("refuses %s, which the adapter does not need", async (path) => {
    const response = await fetch(new URL(path, proxyUrl), { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel();

    expect(response.status).toBe(403);
  });
});
