import {
  assertSandboxId,
  defaultIsolationClass,
  newSandboxId,
  SandboxError,
  type ExecRequest,
  type ExecResult,
  type Sandbox,
  type SandboxApi,
  type SandboxTemplate,
} from "./sandbox-api.js";

interface FakeSandbox {
  sandbox: Sandbox;
  template: SandboxTemplate;
}

/** In-memory sandbox backend for tests and for running the platform without Docker. Nothing is executed. */
export function createFakeSandboxApi(): SandboxApi {
  const sandboxes = new Map<string, FakeSandbox>();

  const find = (sandboxId: string): FakeSandbox => {
    assertSandboxId(sandboxId);
    const found = sandboxes.get(sandboxId);
    if (!found) throw new SandboxError("sandbox-not-found", `no sandbox ${sandboxId}`);
    return found;
  };

  return {
    async create(template) {
      const sandbox: Sandbox = {
        id: newSandboxId(),
        template: template.metadata.name,
        isolationClass: template.spec.isolationClass ?? defaultIsolationClass,
        state: "running",
        createdAt: new Date().toISOString(),
      };
      sandboxes.set(sandbox.id, { sandbox, template });
      return sandbox;
    },
    async exec(sandboxId, request: ExecRequest): Promise<ExecResult> {
      find(sandboxId);
      throw new Error(`fake exec not implemented: ${request.command.join(" ")}`);
    },
    async readFile(sandboxId) {
      find(sandboxId);
      throw new Error("not implemented");
    },
    async writeFile(sandboxId) {
      find(sandboxId);
      throw new Error("not implemented");
    },
    async destroy(sandboxId) {
      sandboxes.delete(sandboxId);
    },
  };
}
