import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const networks = await docker("network", "ls", "-q", "--filter", `label=${runLabel}`);
  if (networks) await docker("network", "rm", ...networks.split(/\s+/));
});

// Installations of this run only, so nothing here meets another stack's sandboxes. The
// neighbour's name starts like this installation's volume names, which must not confuse them.
const installation = `tendworks-test-${crypto.randomUUID().slice(0, 8)}`;
const neighbour = `${installation}-volume`;
// A network sandboxes may join on request, like the platform MCP gateway's (created in the suite's setup).
const gateway = `${installation}_gateway`;
// Starting a sandbox on a network without traffic between its containers takes Docker
// several times longer, so only the tests about the network use one.
// Host directories sandboxes may bind from: a temporary directory of this run, by the path
// the Docker host knows it by (Docker Desktop on Windows sees the drives under /run/desktop/mnt/host).
const bindDirectory = realpathSync.native(mkdtempSync(join(tmpdir(), "tend-binds-")));
const onDockerHost = (path: string) =>
  process.platform === "win32" ? `/run/desktop/mnt/host/${path[0]!.toLowerCase()}${path.slice(2).replaceAll("\\", "/")}` : path;
const bindRoot = onDockerHost(bindDirectory);
async function hostDirectory(): Promise<string> {
  const name = crypto.randomUUID();
  mkdirSync(join(bindDirectory, name));
  chmodSync(join(bindDirectory, name), 0o777); // the sandbox user writes there
  return `${bindRoot}/${name}`;
}
afterAll(() => rmSync(bindDirectory, { recursive: true, force: true }));

const createApi = (name = installation, { sandboxNetwork = false } = {}) =>
  createDockerSandboxApi({
    url: proxyUrl,
    installation: name,
    sandboxNetwork,
    networks: [gateway],
    bindRoots: [bindRoot],
    labels: { [runLabel.split("=")[0]!]: runLabel.split("=")[1]! },
  });

describeSandboxApi("Docker adapter through the socket proxy", async () => {
  await docker("network", "create", "--internal", "--label", runLabel, gateway);
  return { api: createApi(), neighbour: createApi(neighbour), image, network: gateway, bindRoot, hostDirectory };
});

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

describe("Docker adapter resources of an installation", () => {
  const own = `${installation}-own`;
  const created: { api: SandboxApi; id: string }[] = [];
  const volumes: string[] = [];
  const networked: SandboxTemplate = { apiVersion: "tendworks.dev/v1", kind: "SandboxTemplate", metadata: { name: "networked" }, spec: { image } };
  const label = (kind: "container" | "volume" | "network", name: string, key: string) =>
    docker(kind, "inspect", "--format", `{{index .${kind === "container" ? "Config.Labels" : "Labels"} "${key}"}}`, name);

  afterAll(async () => {
    await Promise.all(created.map(({ api, id }) => api.destroy(id)));
    await Promise.all(volumes.map((volume) => createApi(own).deleteVolume(volume)));
  });

  it("names and labels sandboxes, volumes and the sandbox network after the installation", async () => {
    // Two adapters, as after a restart: the second finds the network the first created.
    const adapters = [createApi(own, { sandboxNetwork: true }), createApi(own, { sandboxNetwork: true })];
    const sandboxes = await Promise.all(
      adapters.map(async (adapter, index) => {
        const volume = `named-${index}-${crypto.randomUUID().slice(0, 8)}`;
        volumes.push(volume);
        const sandbox = await adapter.create(networked, { volumes: [{ volume, path: "/tmp" }], owner: `task-${index}` });
        created.push({ api: adapter, id: sandbox.id });
        return { ...sandbox, volume };
      }),
    );

    for (const [index, { id, volume }] of sandboxes.entries()) {
      const container = `${own}-sandbox-${id}`;
      expect(await docker("inspect", "--format", "{{.HostConfig.NetworkMode}}", container)).toBe(`${own}-sandboxes`);
      expect(await label("container", container, "dev.tendworks.installation")).toBe(own);
      expect(await label("container", container, "dev.tendworks.owner")).toBe(`task-${index}`);
      expect(await label("volume", `${own}-volume-${volume}`, "dev.tendworks.installation")).toBe(own);
    }
    expect(await label("network", `${own}-sandboxes`, "dev.tendworks.installation")).toBe(own);
    expect(await docker("network", "inspect", "--format", '{{index .Options "com.docker.network.bridge.enable_icc"}}', `${own}-sandboxes`)).toBe("false");
  });

  it("puts a sandbox that asks for an allowed network on it as well as on the sandbox network", async () => {
    const api = createApi(own, { sandboxNetwork: true });
    const { id } = await api.create(networked, { networks: [gateway] });
    created.push({ api, id });

    const networks = JSON.parse(await docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", `${own}-sandbox-${id}`)) as Record<string, unknown>;

    expect(Object.keys(networks).sort()).toEqual([`${own}-sandboxes`, gateway].sort());
  });

  it("still reaches sandboxes and volumes created before installations had labels, but never lists them", async () => {
    // Before installation names, every stack's resources carried names of the same scheme
    // (`tendworks-sandbox-<id>`, `tendworks-volume-<volume>`) without a label, so the name
    // alone cannot tell this installation's from another stack's: a listing, which the
    // clean-up removes from, leaves them out; a session that knows its sandbox still reaches it.
    const api = createApi(own);
    const id = crypto.randomUUID().replaceAll("-", "");
    const volume = `legacy-${id.slice(0, 8)}`;
    volumes.push(volume);
    await docker("volume", "create", "--label", runLabel, "--label", `dev.tendworks.volume=${volume}`, `${own}-volume-${volume}`);
    await docker(
      "run", "-d", "--name", `${own}-sandbox-${id}`, "--label", runLabel, "--label", `dev.tendworks.sandbox=${id}`,
      "--label", "dev.tendworks.sandbox-template=legacy", "--entrypoint", "sleep", image, "infinity",
    );
    created.push({ api, id });

    expect((await api.list()).map((sandbox) => sandbox.id)).not.toContain(id);
    expect((await api.listVolumes()).map(({ name }) => name)).not.toContain(volume);
    expect((await api.exec(id, { command: ["echo", "still here"] })).stdout).toBe("still here\n");
  });

  it("lists a sandbox that stopped as stopped", async () => {
    const api = createApi(own);
    const { id } = await api.create(networked);
    created.push({ api, id });

    await docker("stop", "-t", "0", `${own}-sandbox-${id}`);

    expect(await api.list()).toContainEqual(expect.objectContaining({ id, state: "stopped" }));
  });
});

describe("socket proxy", () => {
  it.each(["/images/json", "/info", "/events", "/system/df"])("refuses %s, which the adapter does not need", async (path) => {
    const response = await fetch(new URL(path, proxyUrl), { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel();

    expect(response.status).toBe(403);
  });
});
