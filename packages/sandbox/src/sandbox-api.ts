import { posix } from "node:path";
import { isStrictlyUnder } from "@tendworks/platform/workspace-roots";
import type { Sandbox as Contract } from "@tendworks/shared";

type Schemas = Contract.components["schemas"];

export type SandboxTemplate = Schemas["SandboxTemplate"];
export type IsolationClass = Schemas["IsolationClass"];
export type Sandbox = Schemas["Sandbox"];
export type ExecRequest = Schemas["ExecRequest"];
export type VolumeMount = Schemas["VolumeMount"];
export type BindMount = Schemas["BindMount"];
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
   * owner (e.g. a task id) is recorded on the sandbox and the volumes it creates. The
   * sandbox joins the requested networks only if the installation allows them. Host
   * directories are bound only from under the directories the installation allows; a
   * bind is no volume, so nothing here creates, lists or deletes its directory.
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

/**
 * Checks the mounts of a new sandbox: volumes with valid names, host directories strictly
 * under one of `bindRoots` (normalized, so `..` cannot leave them), absolute paths that are
 * not /, each path once. The check is lexical; resolving symbolic links is up to the
 * caller, which sees the host directories (ADR 0022). It is the adapter's own, since the
 * socket proxy cannot inspect request bodies (ADR 0001).
 */
export function assertMounts(volumes: readonly VolumeMount[], binds: readonly BindMount[], bindRoots: readonly string[]): void {
  for (const { volume, path } of volumes) {
    assertVolumeName(volume);
    assertMountPath(path);
  }
  for (const { hostPath, path } of binds) {
    assertMountPath(path);
    if (!bindRoots.some((root) => isBindableUnder(hostPath, root))) {
      throw new SandboxError("invalid-request", `host directory ${JSON.stringify(hostPath)} is not under a directory this installation allows binds from`);
    }
  }
  const paths = [...volumes, ...binds].map(({ path }) => mountPath(path));
  if (new Set(paths).size !== paths.length) throw new SandboxError("invalid-request", "two mounts are on the same path");
}

function assertMountPath(path: string): void {
  assertAbsolutePath(path);
  if (mountPath(path) === "/") throw new SandboxError("invalid-request", "nothing can be mounted on /");
}

/** Whether `hostPath` is a normalized absolute path strictly under `root`, which is not / (both host paths, POSIX). */
function isBindableUnder(hostPath: string, root: string): boolean {
  const normalized = mountPath(posix.normalize(hostPath));
  if (!posix.isAbsolute(hostPath) || normalized !== mountPath(hostPath)) return false;
  const normalizedRoot = mountPath(posix.normalize(root));
  return posix.isAbsolute(root) && normalizedRoot !== "/" && isStrictlyUnder(normalized, normalizedRoot, posix);
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

/** Refuses networks the installation does not let sandboxes join; returns the requested ones, each once. */
export function allowedNetworks(requested: readonly string[], allowed: readonly string[]): string[] {
  const refused = requested.filter((network) => !allowed.includes(network));
  if (refused.length > 0) {
    throw new SandboxError("invalid-request", `sandboxes of this installation may not join the network(s) ${refused.map((network) => JSON.stringify(network)).join(", ")}`);
  }
  return [...new Set(requested)];
}

export function newSandboxId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
