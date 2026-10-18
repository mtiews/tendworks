import {
  assertSandboxId,
  defaultIsolationClass,
  defaultSandboxUser,
  newSandboxId,
  SandboxError,
  type IsolationClass,
  type Sandbox,
  type SandboxApi,
} from "../sandbox-api.js";

export interface DockerSandboxApiOptions {
  /** Base URL of the container API, i.e. the restricted socket proxy (ADR 0001). */
  url: string;
  /** Extra labels for every sandbox container, e.g. to find a test run's containers. */
  labels?: Record<string, string>;
}

const runtimes: Record<IsolationClass, string> = { container: "runc", gvisor: "runsc" };
const containerName = (sandboxId: string) => `tendworks-sandbox-${sandboxId}`;

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

/**
 * Sandbox API on the Docker Engine API. Needs only the socket proxy sections
 * CONTAINERS, EXEC and POST; images must already be on the host.
 */
export function createDockerSandboxApi({ url, labels = {} }: DockerSandboxApiOptions): SandboxApi {
  const call = (method: string, path: string, init: { json?: unknown; body?: Uint8Array; contentType?: string } = {}) => {
    const headers: Record<string, string> = {};
    let body: BodyInit | undefined;
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

  return {
    async create(template) {
      const id = newSandboxId();
      const isolationClass = template.spec.isolationClass ?? defaultIsolationClass;
      const { cpus, memoryMb, pids = 1024 } = template.spec.resources ?? {};

      const created = await call("POST", `/containers/create?name=${containerName(id)}`, {
        json: {
          Image: template.spec.image,
          Entrypoint: ["sleep", "infinity"],
          Cmd: [],
          User: template.spec.user ?? defaultSandboxUser,
          Labels: { ...labels, "dev.tendworks.sandbox": id, "dev.tendworks.sandbox-template": template.metadata.name },
          HostConfig: {
            Runtime: runtimes[isolationClass],
            Init: true,
            Privileged: false,
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
      if (!created.ok) throw await failure(created, "creating the sandbox");

      const started = await call("POST", `/containers/${containerName(id)}/start`);
      if (!started.ok) {
        const error = await failure(started, "starting the sandbox");
        await call("DELETE", `/containers/${containerName(id)}?force=true&v=true`);
        throw error;
      }

      const sandbox: Sandbox = {
        id,
        template: template.metadata.name,
        isolationClass,
        state: "running",
        createdAt: new Date().toISOString(),
      };
      return sandbox;
    },
    async exec(sandboxId, request) {
      assertSandboxId(sandboxId);
      const created = await call("POST", `/containers/${containerName(sandboxId)}/exec`, {
        json: {
          Cmd: request.command,
          AttachStdout: true,
          AttachStderr: true,
          ...(request.workingDirectory === undefined ? {} : { WorkingDir: request.workingDirectory }),
          ...(request.env === undefined ? {} : { Env: Object.entries(request.env).map(([key, value]) => `${key}=${value}`) }),
        },
      });
      if (created.status === 404) throw new SandboxError("sandbox-not-found", `no sandbox ${sandboxId}`);
      if (!created.ok) throw await failure(created, "starting a command");
      const { Id: execId } = (await created.json()) as { Id: string };

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
    async readFile() {
      throw new Error("not implemented");
    },
    async writeFile() {
      throw new Error("not implemented");
    },
    async destroy(sandboxId) {
      assertSandboxId(sandboxId);
      const response = await call("DELETE", `/containers/${containerName(sandboxId)}?force=true&v=true`);
      if (!response.ok && response.status !== 404) throw await failure(response, "destroying the sandbox");
    },
  };
}
