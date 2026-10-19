import type { Sandbox as Contract } from "@tendworks/shared";

type Schemas = Contract.components["schemas"];

export type SandboxTemplate = Schemas["SandboxTemplate"];
export type IsolationClass = Schemas["IsolationClass"];
export type Sandbox = Schemas["Sandbox"];
export type ExecRequest = Schemas["ExecRequest"];
export type ExecResult = Schemas["ExecResult"];
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
 * (Docker, a fake, later OpenSandbox or agent-sandbox) implements it.
 */
export interface SandboxApi {
  /** Creates and starts a sandbox; it runs until it is destroyed. */
  create(template: SandboxTemplate): Promise<Sandbox>;
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
  /** Destroys the sandbox and everything in it. Idempotent. */
  destroy(sandboxId: string): Promise<void>;
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

const sandboxIdPattern = /^[a-z0-9]{1,32}$/;

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

export function assertAbsolutePath(path: string): void {
  if (!path.startsWith("/")) throw new SandboxError("invalid-request", `path must be absolute: ${path}`);
}

export function newSandboxId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
