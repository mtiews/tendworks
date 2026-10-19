import {
  assertAbsolutePath,
  assertSandboxId,
  defaultIsolationClass,
  sandboxUser,
  newSandboxId,
  SandboxError,
  type AttachedProcess,
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
 * `attach` runs the same commands; `cat` without arguments echoes its input
 * until the input is closed.
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
      sandboxes.set(sandbox.id, { sandbox, user: sandboxUser(template), files: new Map() });
      return sandbox;
    },
    async exec(sandboxId, request) {
      return run(find(sandboxId), request);
    },
    async attach(sandboxId, request) {
      const sandbox = find(sandboxId);
      const [program, ...args] = request.command;
      if (program === "cat" && args.length === 0) return echo();
      return finished(run(sandbox, request));
    },
    async readFile(sandboxId, path) {
      const { files } = find(sandboxId);
      assertAbsolutePath(path);
      const content = files.get(path);
      if (!content) throw new SandboxError("file-not-found", `no file ${path} in sandbox ${sandboxId}`);
      return content.slice();
    },
    async writeFile(sandboxId, path, content) {
      const { files } = find(sandboxId);
      assertAbsolutePath(path);
      files.set(path, content.slice());
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

let processes = 0;
const encoder = new TextEncoder();

/** A process that copies its input to its output until the input is closed. */
function echo(): AttachedProcess {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (exit = resolve));
  const [stdout, watched] = readable.tee();
  void watched.pipeTo(new WritableStream()).then(() => exit(0));
  return { id: `fake${++processes}`, stdin: writable, stdout, stderr: streamOf(""), exited };
}

/** A process that has already run to its end. */
function finished({ exitCode, stdout, stderr }: ExecResult): AttachedProcess {
  return {
    id: `fake${++processes}`,
    stdin: new WritableStream(),
    stdout: streamOf(stdout),
    stderr: streamOf(stderr),
    exited: Promise.resolve(exitCode),
  };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text !== "") controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}
