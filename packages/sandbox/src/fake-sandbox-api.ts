import {
  assertSandboxId,
  defaultIsolationClass,
  defaultSandboxUser,
  newSandboxId,
  SandboxError,
  type ExecRequest,
  type ExecResult,
  type Sandbox,
  type SandboxApi,
} from "./sandbox-api.js";

interface FakeSandbox {
  sandbox: Sandbox;
  user: string;
  files: Map<string, Uint8Array>;
}

/**
 * In-memory sandbox backend for tests and for running the platform without
 * Docker. Nothing is executed: `exec` understands a handful of busybox
 * commands (echo, cat, id -u, pwd, printenv) and answers 127 for anything else.
 */
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
      sandboxes.set(sandbox.id, { sandbox, user: template.spec.user ?? defaultSandboxUser, files: new Map() });
      return sandbox;
    },
    async exec(sandboxId, request) {
      return run(find(sandboxId), request);
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

function run(sandbox: FakeSandbox, { command, workingDirectory = "/", env = {} }: ExecRequest): ExecResult {
  const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
  const [program, ...args] = command;
  switch (program) {
    case "echo":
      return ok(`${args.join(" ")}\n`);
    case "id":
      return ok(`${sandbox.user.split(":")[0]}\n`);
    case "pwd":
      return ok(`${workingDirectory}\n`);
    case "printenv": {
      const value = env[args[0] ?? ""];
      return value === undefined ? { exitCode: 1, stdout: "", stderr: "" } : ok(`${value}\n`);
    }
    case "cat": {
      const missing = args.filter((path) => !sandbox.files.has(path));
      if (missing.length > 0) {
        return { exitCode: 1, stdout: "", stderr: missing.map((path) => `cat: can't open '${path}': No such file or directory\n`).join("") };
      }
      return ok(Buffer.concat(args.map((path) => sandbox.files.get(path)!)).toString("utf8"));
    }
    default:
      return { exitCode: 127, stdout: "", stderr: `${program}: not found\n` };
  }
}
