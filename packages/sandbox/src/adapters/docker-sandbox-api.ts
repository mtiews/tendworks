import { request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { posix } from "node:path";
import {
  allowedNetworks,
  assertAbsolutePath,
  assertInstallation,
  assertSandboxId,
  assertVolumeMounts,
  assertVolumeName,
  defaultInstallation,
  defaultIsolationClass,
  mountPath,
  sandboxIdPattern,
  sandboxUser,
  newSandboxId,
  SandboxError,
  volumeNamePattern,
  type ExecRequest,
  type IsolationClass,
  type Sandbox,
  type SandboxApi,
  type Volume,
} from "../sandbox-api.js";
import { firstTarEntry, tarSingleFile } from "./tar.js";

export interface DockerSandboxApiOptions {
  /** Base URL of the container API, i.e. the restricted socket proxy (ADR 0001). */
  url: string;
  /**
   * The installation this adapter serves (the compose project name), `tendworks` by
   * default. Its sandboxes, volumes and sandbox network are named and labelled after it:
   * `<installation>-sandbox-<id>`, `<installation>-volume-<volume>` and
   * `<installation>-sandboxes`. The adapter lists and touches nothing else.
   */
  installation?: string;
  /** Extra labels for every sandbox container, volume and network, e.g. to find a test run's. */
  labels?: Record<string, string>;
  /**
   * Whether sandboxes run on the installation's own network (the default). `false` puts
   * them on Docker's default bridge, where starting one is several times faster; only
   * for tests that do not care about the network.
   */
  sandboxNetwork?: boolean;
  /**
   * Networks sandboxes may join on request besides the sandbox network, e.g. a gateway's
   * network that the deployment created; none by default. Sandboxes on one of them can
   * reach every container on it, including each other unless the network forbids it.
   */
  networks?: readonly string[];
}

const runtimes: Record<IsolationClass, string> = { container: "runc", gvisor: "runsc" };
const isolationClasses = Object.keys(runtimes) as IsolationClass[];

const LABEL = {
  installation: "dev.tendworks.installation",
  owner: "dev.tendworks.owner",
  sandbox: "dev.tendworks.sandbox",
  template: "dev.tendworks.sandbox-template",
  isolationClass: "dev.tendworks.sandbox-isolation-class",
  volume: "dev.tendworks.volume",
  network: "dev.tendworks.sandbox-network",
} as const;

type Labels = Record<string, string> | null | undefined;

const filters = (label: string) => `filters=${encodeURIComponent(JSON.stringify({ label: [label] }))}`;

/** Splits Docker's multiplexed attach stream: frames of [stream, 0, 0, 0, size (4 bytes, big endian)] + payload. */
function demultiplex(raw: Uint8Array): { stdout: string; stderr: string } {
  const chunks: Record<1 | 2, Uint8Array[]> = { 1: [], 2: [] };
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let offset = 0; offset + 8 <= raw.length; ) {
    const stream = raw[offset];
    const size = view.getUint32(offset + 4);
    const payload = raw.subarray(offset + 8, offset + 8 + size);
    if (stream === 1 || stream === 2) chunks[stream].push(payload);
    offset += 8 + size;
  }
  const decode = (parts: Uint8Array[]) => Buffer.concat(parts).toString("utf8");
  return { stdout: decode(chunks[1]), stderr: decode(chunks[2]) };
}

/** Reads Docker's multiplexed attach stream frame by frame as chunks arrive. */
class FrameReader {
  seenStdout = false;
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly onFrame: (stream: number, payload: Uint8Array) => void) {}

  read(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const size = this.buffer.readUInt32BE(4);
      if (this.buffer.length < 8 + size) return;
      this.onFrame(this.buffer[0]!, new Uint8Array(this.buffer.subarray(8, 8 + size)));
      this.buffer = this.buffer.subarray(8 + size);
    }
  }
}

/** A readable stream fed from outside; pushes after the reader cancelled are dropped. */
function pushStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => void (controller = c),
    cancel: () => void (open = false),
  });
  return {
    stream,
    push(chunk: Uint8Array) {
      if (open) controller.enqueue(chunk);
    },
    end() {
      if (open) controller.close();
      open = false;
    },
  };
}

/** Starts an exec with the connection upgraded to a raw stream (Docker's "hijacked" attach). */
function upgrade(target: URL, body: unknown): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = httpRequest(target, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), connection: "Upgrade", upgrade: "tcp" },
    });
    request.once("upgrade", (_response, socket, head) => {
      if (head.length > 0) socket.unshift(head);
      resolve(socket);
    });
    request.once("response", (response) => {
      let text = "";
      response.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
      response.once("end", () => reject(new Error(`starting a command failed: ${response.statusCode} ${text.trim()}`)));
    });
    request.once("error", reject);
    request.end(payload);
  });
}

/**
 * Sandbox API on the Docker Engine API. Needs only the socket proxy sections
 * CONTAINERS, EXEC, VOLUMES, NETWORKS and POST; images must already be on the host.
 * Sandboxes run on the installation's own network, created on first use as a bridge
 * without traffic between its containers, apart from the platform's networks, so a
 * sandbox cannot reach the platform's services.
 */
export function createDockerSandboxApi({
  url,
  installation = defaultInstallation,
  labels: extraLabels = {},
  sandboxNetwork = true,
  networks: allowed = [],
}: DockerSandboxApiOptions): SandboxApi {
  assertInstallation(installation);
  const containerName = (sandboxId: string) => `${installation}-sandbox-${sandboxId}`;
  const volumeName = (volume: string) => `${installation}-volume-${volume}`;
  const network = `${installation}-sandboxes`;
  const labels = { ...extraLabels, [LABEL.installation]: installation };
  const ownerLabel = (owner: string | undefined) => (owner === undefined ? {} : { [LABEL.owner]: owner });
  // Ours: named after this installation and labelled for it. Resources from before
  // installation names have no installation label; their name alone decides.
  const ours = (name: string, logical: string | undefined, found: Labels, nameOf: (logical: string) => string) =>
    logical !== undefined && name === nameOf(logical) && [installation, undefined].includes(found?.[LABEL.installation]);

  const call = (method: string, path: string, init: { json?: unknown; body?: Uint8Array; contentType?: string } = {}) => {
    const headers: Record<string, string> = {};
    let body: RequestInit["body"];
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.body !== undefined) {
      headers["content-type"] = init.contentType ?? "application/octet-stream";
      body = init.body;
    }
    return fetch(new URL(path, url), { method, headers, body: body ?? null });
  };

  const failure = async (response: Response, action: string) =>
    new Error(`${action} failed: ${response.status} ${(await response.text()).trim()}`);

  const notFound = async (response: Response, sandboxId: string, path: string) => {
    const message = (await response.text()).toLowerCase();
    return message.includes("no such container")
      ? new SandboxError("sandbox-not-found", `no sandbox ${sandboxId}`)
      : new SandboxError("file-not-found", `no file ${path} in sandbox ${sandboxId}`);
  };

  const createExec = async (sandboxId: string, request: ExecRequest, { stdin }: { stdin: boolean }): Promise<string> => {
    assertSandboxId(sandboxId);
    const created = await call("POST", `/containers/${containerName(sandboxId)}/exec`, {
      json: {
        Cmd: request.command,
        AttachStdin: stdin,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false, // keeps stdout and stderr apart and the bytes untouched
        ...(request.workingDirectory === undefined ? {} : { WorkingDir: request.workingDirectory }),
        ...(request.env === undefined ? {} : { Env: Object.entries(request.env).map(([key, value]) => `${key}=${value}`) }),
      },
    });
    if (created.status === 404) throw new SandboxError("sandbox-not-found", `no sandbox ${sandboxId}`);
    if (!created.ok) throw await failure(created, "starting a command");
    return ((await created.json()) as { Id: string }).Id;
  };

  // Created once per adapter; a failed attempt is retried with the next sandbox.
  let networkReady: Promise<void> | undefined;
  const ensureNetwork = (name = network) =>
    (networkReady ??= (async () => {
      const found = await call("GET", `/networks/${encodeURIComponent(name)}`);
      await found.body?.cancel();
      if (found.ok) return;
      if (found.status !== 404) throw await failure(found, `finding the sandbox network ${name}`);
      const created = await call("POST", "/networks/create", {
        json: {
          Name: name,
          Driver: "bridge",
          // No traffic between sandboxes; each one only reaches the outside.
          Options: { "com.docker.network.bridge.enable_icc": "false" },
          Labels: { ...labels, [LABEL.network]: "true" },
        },
      });
      // 409: another adapter created it meanwhile.
      if (!created.ok && created.status !== 409) throw await failure(created, `creating the sandbox network ${name}`);
      await created.body?.cancel();
    })().catch((error: unknown) => {
      networkReady = undefined;
      throw error;
    }));

  const api: SandboxApi = {
    async create(template, { volumes = [], owner, networks: requested = [] } = {}) {
      assertVolumeMounts(volumes);
      const networks = allowedNetworks(requested, allowed);
      if (sandboxNetwork) await ensureNetwork();
      const id = newSandboxId();
      const isolationClass = template.spec.isolationClass ?? defaultIsolationClass;
      const { cpus, memoryMb, pids = 1024 } = template.spec.resources ?? {};

      const created = await call("POST", `/containers/create?name=${containerName(id)}`, {
        json: {
          Image: template.spec.image,
          Entrypoint: ["sleep", "infinity"],
          Cmd: [],
          User: sandboxUser(template),
          Labels: {
            ...labels,
            ...ownerLabel(owner),
            [LABEL.sandbox]: id,
            [LABEL.template]: template.metadata.name,
            [LABEL.isolationClass]: isolationClass,
          },
          HostConfig: {
            Runtime: runtimes[isolationClass],
            Init: true,
            Privileged: false, // always set explicitly: the socket proxy cannot stop a privileged container (it filters paths, not bodies)
            Binds: [], // no host mounts, only named volumes
            // A named volume is created on first use and, while empty, takes over the content
            // and ownership of the image directory it is mounted on.
            Mounts: volumes.map(({ volume, path }) => ({
              Type: "volume",
              Source: volumeName(volume),
              Target: mountPath(path),
              VolumeOptions: { Labels: { ...labels, ...ownerLabel(owner), [LABEL.volume]: volume } },
            })),
            ...(sandboxNetwork ? { NetworkMode: network } : {}),
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            PidsLimit: pids,
            ...(cpus === undefined ? {} : { NanoCpus: Math.round(cpus * 1e9) }),
            ...(memoryMb === undefined ? {} : { Memory: memoryMb * 1024 * 1024 }),
          },
        },
      });
      if (created.status === 404) {
        throw new SandboxError("image-not-found", `image ${template.spec.image} is not on the sandbox host`);
      }
      if (!created.ok) {
        const message = (await created.text()).trim();
        if (/runtime/i.test(message)) {
          throw new SandboxError(
            "isolation-class-unavailable",
            `isolation class ${isolationClass} needs the ${runtimes[isolationClass]} runtime on the sandbox host: ${message}`,
          );
        }
        throw new Error(`creating the sandbox failed: ${created.status} ${message}`);
      }

      const discard = async (error: Error) => {
        await call("DELETE", `/containers/${containerName(id)}?force=true&v=true`);
        return error;
      };
      // Joined before it starts, so nothing in it runs before it is on every network.
      for (const joined of networks) {
        const connected = await call("POST", `/networks/${encodeURIComponent(joined)}/connect`, { json: { Container: containerName(id) } });
        if (!connected.ok) throw await discard(await failure(connected, `joining the network ${joined}`));
        await connected.body?.cancel();
      }

      const started = await call("POST", `/containers/${containerName(id)}/start`);
      if (!started.ok) throw await discard(await failure(started, "starting the sandbox"));

      const sandbox: Sandbox = {
        id,
        template: template.metadata.name,
        isolationClass,
        state: "running",
        createdAt: new Date().toISOString(),
        ...(owner === undefined ? {} : { owner }),
        ...(networks.length === 0 ? {} : { networks }),
      };
      return sandbox;
    },
    async list() {
      const response = await call("GET", `/containers/json?all=true&${filters(LABEL.sandbox)}`);
      if (!response.ok) throw await failure(response, "listing the sandboxes");
      const containers = (await response.json()) as {
        Names: string[];
        Labels: Labels;
        State: string;
        Created: number;
        NetworkSettings?: { Networks?: Record<string, unknown> | null };
      }[];
      return containers.flatMap(({ Names, Labels: found, State, Created, NetworkSettings }): Sandbox[] => {
        const id = found?.[LABEL.sandbox];
        if (!Names.some((name) => ours(name.replace(/^\//, ""), id, found, containerName)) || !sandboxIdPattern.test(id!)) return [];
        const isolationClass = isolationClasses.find((candidate) => candidate === found?.[LABEL.isolationClass]) ?? defaultIsolationClass;
        const owner = found?.[LABEL.owner];
        const networks = allowed.filter((network) => network in (NetworkSettings?.Networks ?? {}));
        return [
          {
            id: id!,
            template: found?.[LABEL.template] ?? "",
            isolationClass,
            state: State === "running" ? "running" : "stopped",
            createdAt: new Date(Created * 1000).toISOString(),
            ...(owner === undefined ? {} : { owner }),
            ...(networks.length === 0 ? {} : { networks }),
          },
        ];
      });
    },
    async listVolumes() {
      const response = await call("GET", `/volumes?${filters(LABEL.volume)}`);
      if (!response.ok) throw await failure(response, "listing the volumes");
      const { Volumes } = (await response.json()) as { Volumes: { Name: string; Labels: Labels }[] | null };
      return (Volumes ?? []).flatMap(({ Name, Labels: found }): Volume[] => {
        const volume = found?.[LABEL.volume];
        if (!ours(Name, volume, found, volumeName) || !volumeNamePattern.test(volume!)) return [];
        const owner = found?.[LABEL.owner];
        return [{ name: volume!, ...(owner === undefined ? {} : { owner }) }];
      });
    },
    async exec(sandboxId, request) {
      const execId = await createExec(sandboxId, request, { stdin: false });

      const started = await call("POST", `/exec/${execId}/start`, { json: { Detach: false, Tty: false } });
      if (!started.ok) throw await failure(started, "starting a command");
      const { stdout, stderr } = demultiplex(new Uint8Array(await started.arrayBuffer()));

      const inspected = await call("GET", `/exec/${execId}/json`);
      if (!inspected.ok) throw await failure(inspected, "reading the exit code");
      const { ExitCode } = (await inspected.json()) as { ExitCode: number };

      // When the program cannot be started, the runtime writes its error to the stdout stream.
      if (stdout.startsWith("OCI runtime exec failed")) return { exitCode: ExitCode, stdout: "", stderr: stderr + stdout };
      return { exitCode: ExitCode, stdout, stderr };
    },
    async attach(sandboxId, request) {
      const execId = await createExec(sandboxId, request, { stdin: true });
      const socket = await upgrade(new URL(`/exec/${execId}/start`, url), { Detach: false, Tty: false });
      const stdout = pushStream();
      const stderr = pushStream();
      const frames = new FrameReader((stream, payload) => {
        // When the program cannot be started, the runtime writes its error to the stdout stream.
        if (stream === 1 && !frames.seenStdout && Buffer.from(payload).toString("utf8").startsWith("OCI runtime exec failed")) stream = 2;
        if (stream === 1) frames.seenStdout = true;
        (stream === 1 ? stdout : stream === 2 ? stderr : undefined)?.push(payload);
      });
      const ended = new Promise<void>((resolve) => {
        socket.on("data", (chunk: Buffer) => frames.read(chunk));
        socket.once("close", () => {
          stdout.end();
          stderr.end();
          resolve();
        });
      });
      socket.once("error", () => socket.destroy());

      const exited = ended.then(async () => {
        // The stream ends as the process exits; the engine may need a moment to record the exit code.
        for (let attempt = 0; ; attempt++) {
          const inspected = await call("GET", `/exec/${execId}/json`);
          if (!inspected.ok) throw await failure(inspected, "reading the exit code");
          const { Running, ExitCode } = (await inspected.json()) as { Running: boolean; ExitCode: number | null };
          if (!Running && ExitCode !== null) return ExitCode;
          if (attempt >= 50) throw new Error(`process ${execId} in sandbox ${sandboxId} did not report an exit code`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      });
      exited.catch(() => {}); // callers that never await the exit must not cause an unhandled rejection

      const stdin = new WritableStream<Uint8Array>({
        write: (chunk) =>
          new Promise<void>((resolve, reject) => socket.write(chunk, (error) => (error ? reject(error) : resolve()))),
        close: () => new Promise<void>((resolve) => socket.end(resolve)), // half-close: the process sees the end of its input
        abort: () => void socket.destroy(),
      });
      return { id: execId, stdin, stdout: stdout.stream, stderr: stderr.stream, exited };
    },
    async readFile(sandboxId, path) {
      assertSandboxId(sandboxId);
      assertAbsolutePath(path);
      const response = await call("GET", `/containers/${containerName(sandboxId)}/archive?path=${encodeURIComponent(path)}`);
      if (response.status === 404) throw await notFound(response, sandboxId, path);
      if (!response.ok) throw await failure(response, "reading a file");
      const entry = firstTarEntry(new Uint8Array(await response.arrayBuffer()));
      if (entry.type !== "file") throw new SandboxError("invalid-request", `${path} is not a regular file`);
      return entry.content;
    },
    async writeFile(sandboxId, path, content) {
      assertSandboxId(sandboxId);
      assertAbsolutePath(path);
      const directory = posix.dirname(path);
      const created = await api.exec(sandboxId, { command: ["mkdir", "-p", directory] });
      if (created.exitCode !== 0) throw new SandboxError("invalid-request", `cannot create ${directory}: ${created.stderr.trim()}`);

      // copyUIDGID hands the file to the sandbox user.
      const response = await call("PUT", `/containers/${containerName(sandboxId)}/archive?path=${encodeURIComponent(directory)}&copyUIDGID=true`, {
        body: tarSingleFile(posix.basename(path), content),
        contentType: "application/x-tar",
      });
      if (response.status === 404) throw await notFound(response, sandboxId, path);
      if (!response.ok) throw await failure(response, "writing a file");
    },
    async destroy(sandboxId) {
      assertSandboxId(sandboxId);
      const response = await call("DELETE", `/containers/${containerName(sandboxId)}?force=true&v=true`);
      if (!response.ok && response.status !== 404) throw await failure(response, "destroying the sandbox");
    },
    async deleteVolume(volume) {
      assertVolumeName(volume);
      const response = await call("DELETE", `/volumes/${volumeName(volume)}`);
      if (response.status === 409) throw new SandboxError("volume-in-use", `volume ${volume} is mounted by a sandbox`);
      if (!response.ok && response.status !== 404) throw await failure(response, "deleting the volume");
    },
  };
  return api;
}
