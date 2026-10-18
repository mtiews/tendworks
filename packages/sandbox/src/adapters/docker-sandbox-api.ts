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
    async exec() {
      throw new Error("not implemented");
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
