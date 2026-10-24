import {
  allowedNetworks,
  assertAbsolutePath,
  assertInstallation,
  assertSandboxId,
  assertMounts,
  assertVolumeName,
  defaultInstallation,
  defaultIsolationClass,
  mountPath,
  sandboxUser,
  newSandboxId,
  SandboxError,
  type AttachedProcess,
  type ExecRequest,
  type ExecResult,
  type Sandbox,
  type SandboxApi,
  type Volume,
} from "./sandbox-api.js";

type Files = Map<string, Uint8Array>;

interface FakeSandbox {
  installation: string;
  sandbox: Sandbox;
  user: string;
  /** Files outside volumes, by absolute path. */
  files: Files;
  /** Mounted volumes and bound host directories by mount path; their files by path relative to it. */
  mounts: Map<string, Files>;
  /** Mount paths the sandbox may only read. */
  readOnly: Set<string>;
}

interface FakeVolume {
  files: Files;
  owner?: string;
  createdAt: string;
}

/** The state of a fake backend, which several installations may share. */
export interface FakeSandboxBackend {
  sandboxes: Map<string, FakeSandbox>;
  /** Volumes by installation and name ("<installation>/<name>"). */
  volumes: Map<string, FakeVolume>;
  /** Host directories by host path, with their files; created empty on first bind. */
  hostDirectories: Map<string, Files>;
}

export function createFakeSandboxBackend(): FakeSandboxBackend {
  return { sandboxes: new Map(), volumes: new Map(), hostDirectories: new Map() };
}

export interface FakeSandboxApiOptions {
  /** Shared with other fakes to put several installations on one backend; a new one by default. */
  backend?: FakeSandboxBackend;
  installation?: string;
  /** Networks sandboxes may join on request; none by default. */
  networks?: readonly string[];
  /** Host directories under which sandboxes may bind directories; none by default. */
  bindRoots?: readonly string[];
}

/** Where a file lives: in the sandbox itself or in a mounted volume, and under which key. */
function locate(sandbox: FakeSandbox, path: string): { files: Files; key: string; mount?: string } {
  for (const [mount, files] of sandbox.mounts) {
    if (path.startsWith(`${mount}/`)) return { files, key: path.slice(mount.length + 1), mount };
  }
  return { files: sandbox.files, key: path };
}

/**
 * In-memory sandbox backend for tests and for running the platform without
 * Docker. Nothing is executed: `exec` understands a handful of busybox
 * commands (echo, cat, id -u, pwd, printenv) and answers 127 for anything else.
 * `attach` runs the same commands; `cat` without arguments echoes its input
 * until the input is closed. Volumes are kept in memory beyond their sandboxes.
 */
export function createFakeSandboxApi({
  backend = createFakeSandboxBackend(),
  installation = defaultInstallation,
  networks: allowed = [],
  bindRoots = [],
}: FakeSandboxApiOptions = {}): SandboxApi {
  assertInstallation(installation);
  const { sandboxes } = backend;
  const volumeKey = (volume: string) => `${installation}/${volume}`;

  const find = (sandboxId: string): FakeSandbox => {
    assertSandboxId(sandboxId);
    const found = sandboxes.get(sandboxId);
    if (!found || found.installation !== installation) throw new SandboxError("sandbox-not-found", `no sandbox ${sandboxId}`);
    return found;
  };

  return {
    async create(template, { volumes: mounts = [], binds = [], owner, networks: requested = [] } = {}) {
      assertMounts(mounts, binds, bindRoots);
      const networks = allowedNetworks(requested, allowed);
      const user = sandboxUser(template);
      const sandbox: Sandbox = {
        id: newSandboxId(),
        template: template.metadata.name,
        isolationClass: template.spec.isolationClass ?? defaultIsolationClass,
        state: "running",
        createdAt: new Date().toISOString(),
        ...(owner === undefined ? {} : { owner }),
        ...(networks.length === 0 ? {} : { networks }),
      };
      const mounted = new Map<string, Files>();
      for (const { volume, path } of mounts) {
        const key = volumeKey(volume);
        if (!backend.volumes.has(key)) backend.volumes.set(key, { files: new Map(), createdAt: new Date().toISOString(), ...(owner === undefined ? {} : { owner }) });
        mounted.set(mountPath(path), backend.volumes.get(key)!.files);
      }
      const readOnly = new Set<string>();
      for (const { hostPath, path, readOnly: only } of binds) {
        if (!backend.hostDirectories.has(hostPath)) backend.hostDirectories.set(hostPath, new Map());
        mounted.set(mountPath(path), backend.hostDirectories.get(hostPath)!);
        if (only) readOnly.add(mountPath(path));
      }
      sandboxes.set(sandbox.id, { installation, sandbox, user, files: new Map(), mounts: mounted, readOnly });
      return structuredClone(sandbox);
    },
    async list() {
      return [...sandboxes.values()].filter((found) => found.installation === installation).map(({ sandbox }) => structuredClone(sandbox));
    },
    async listVolumes() {
      const prefix = volumeKey("");
      return [...backend.volumes]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, { owner, createdAt }]): Volume => ({ name: key.slice(prefix.length), createdAt, ...(owner === undefined ? {} : { owner }) }));
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
      const sandbox = find(sandboxId);
      assertAbsolutePath(path);
      const { files, key } = locate(sandbox, path);
      const content = files.get(key);
      if (!content) throw new SandboxError("file-not-found", `no file ${path} in sandbox ${sandboxId}`);
      return content.slice();
    },
    async writeFile(sandboxId, path, content) {
      const sandbox = find(sandboxId);
      assertAbsolutePath(path);
      const { files, key, mount } = locate(sandbox, path);
      if (mount !== undefined && sandbox.readOnly.has(mount)) throw new SandboxError("invalid-request", `${path} is on a read-only mount of sandbox ${sandboxId}`);
      files.set(key, content.slice());
    },
    async destroy(sandboxId) {
      if (sandboxes.get(sandboxId)?.installation === installation) sandboxes.delete(sandboxId);
    },
    async deleteVolume(volume) {
      assertVolumeName(volume);
      const files = backend.volumes.get(volumeKey(volume))?.files;
      if (files && [...sandboxes.values()].some(({ mounts }) => [...mounts.values()].includes(files))) {
        throw new SandboxError("volume-in-use", `volume ${volume} is mounted by a sandbox`);
      }
      backend.volumes.delete(volumeKey(volume));
    },
  };
}

function run(sandbox: FakeSandbox, { command, workingDirectory = "/", env = {} }: ExecRequest): ExecResult {
  const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
  const read = (path: string) => {
    const { files, key } = locate(sandbox, path);
    return files.get(key);
  };
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
      const missing = args.filter((path) => read(path) === undefined);
      if (missing.length > 0) {
        return { exitCode: 1, stdout: "", stderr: missing.map((path) => `cat: can't open '${path}': No such file or directory\n`).join("") };
      }
      return ok(Buffer.concat(args.map((path) => read(path)!)).toString("utf8"));
    }
    case undefined:
      return { exitCode: 127, stdout: "", stderr: "no command given\n" };
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
