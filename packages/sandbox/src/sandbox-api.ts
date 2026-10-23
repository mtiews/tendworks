import type { Sandbox as Contract } from "@tendworks/shared";

type Schemas = Contract.components["schemas"];

export type SandboxTemplate = Schemas["SandboxTemplate"];
export type IsolationClass = Schemas["IsolationClass"];
export type Sandbox = Schemas["Sandbox"];
export type ExecRequest = Schemas["ExecRequest"];
export type VolumeMount = Schemas["VolumeMount"];
export type ExecResult = Schemas["ExecResult"];
export type Volume = Schemas["Volume"];
export type CreateSandboxOptions = Omit<Schemas["CreateSandboxRequest"], "template">;
export type SandboxErrorCode = Schemas["Error"]["code"];

/** A process started with {@link SandboxApi.attach}, with its standard streams open. */
export interface AttachedProcess {
  id: Schemas["ProcessId"];
  /** Standard input; closing it closes the process's input. */
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  /** Resolves with the exit code once the process has ended (127: the program could not be started). */
  exited: Promise<number>;
}

/**
 * The sandbox API (contracts/openapi/sandbox.yaml) as a port. Every backend
 * (Docker, a fake, later OpenSandbox or agent-sandbox) implements it. An
 * implementation serves one installation: it lists, reaches and deletes only
 * that installation's sandboxes and volumes, even when installations share a backend.
 *
 * @port
 */
export interface SandboxApi {
  /**
   * Creates and starts a sandbox; it runs until it is destroyed. Volumes are created
   * on first use and outlive the sandbox until {@link SandboxApi.deleteVolume}. The
   * owner (e.g. a task id) is recorded on the sandbox and the volumes it creates.
   */
  create(template: SandboxTemplate, options?: CreateSandboxOptions): Promise<Sandbox>;
  /** The installation's sandboxes, also stopped ones and those nobody remembers. */
  list(): Promise<Sandbox[]>;
  /** The installation's volumes. */
  listVolumes(): Promise<Volume[]>;
  /** Runs a command as the sandbox user and waits for it to finish. */
  exec(sandboxId: string, request: ExecRequest): Promise<ExecResult>;
  /**
   * Starts a command as the sandbox user and hands back its open standard streams,
   * e.g. for a harness that speaks a protocol over stdio. Resolves once it runs.
   */
  attach(sandboxId: string, request: ExecRequest): Promise<AttachedProcess>;
  /** Reads a regular file; `path` is absolute. */
  readFile(sandboxId: string, path: string): Promise<Uint8Array>;
  /** Writes a file owned by the sandbox user, creating missing parent directories. */
  writeFile(sandboxId: string, path: string, content: Uint8Array): Promise<void>;
  /** Destroys the sandbox and everything in it except its volumes. Idempotent. */
  destroy(sandboxId: string): Promise<void>;
  /** Deletes a volume and its files; fails with `volume-in-use` while a sandbox mounts it. Idempotent. */
  deleteVolume(volume: string): Promise<void>;
}

export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

export const defaultIsolationClass: IsolationClass = "container";
export const defaultSandboxUser = "1000:1000";

export const sandboxIdPattern = /^[a-z0-9]{1,32}$/;

/** Rejects ids that are not sandbox ids, so they can never address anything else on the backend. */
export function assertSandboxId(sandboxId: string): void {
  if (!sandboxIdPattern.test(sandboxId)) throw new SandboxError("sandbox-not-found", `no sandbox ${JSON.stringify(sandboxId)}`);
}

/** The template's user as numeric uid:gid, refusing root (also as group) and names that could resolve to it. */
export function sandboxUser(template: SandboxTemplate): string {
  const user = template.spec.user ?? defaultSandboxUser;
  const match = /^([1-9][0-9]*)(?::([1-9][0-9]*))?$/.exec(user);
  if (!match) throw new SandboxError("invalid-request", `sandbox user must be a numeric non-root uid[:gid], got ${JSON.stringify(user)}`);
  return `${match[1]}:${match[2] ?? match[1]}`;
}

export const volumeNamePattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function assertVolumeName(volume: string): void {
  if (!volumeNamePattern.test(volume)) throw new SandboxError("invalid-request", `not a volume name: ${JSON.stringify(volume)}`);
}

/** Checks the volumes of a new sandbox: valid names, absolute paths, each path once. */
export function assertVolumeMounts(volumes: VolumeMount[]): void {
  for (const { volume, path } of volumes) {
    assertVolumeName(volume);
    assertAbsolutePath(path);
    if (mountPath(path) === "/") throw new SandboxError("invalid-request", "a volume cannot be mounted on /");
  }
  const paths = volumes.map(({ path }) => mountPath(path));
  if (new Set(paths).size !== paths.length) throw new SandboxError("invalid-request", "two volumes are mounted on the same path");
}

/** A mount path without trailing slashes. */
export const mountPath = (path: string) => path.replace(/\/+$/, "") || "/";

export function assertAbsolutePath(path: string): void {
  if (!path.startsWith("/")) throw new SandboxError("invalid-request", `path must be absolute: ${path}`);
}

/** Names an installation can have: they become part of resource names on the backend. */
const installationPattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const defaultInstallation = "tendworks";

export function assertInstallation(installation: string): void {
  if (!installationPattern.test(installation)) {
    throw new SandboxError(
      "invalid-request",
      `not an installation name (lowercase letters, digits, "-" and "_", starting with a letter or digit): ${JSON.stringify(installation)}`,
    );
  }
}

export function newSandboxId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
