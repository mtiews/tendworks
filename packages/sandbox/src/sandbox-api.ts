import type { Sandbox as Contract } from "@tendworks/shared";

type Schemas = Contract.components["schemas"];

export type SandboxTemplate = Schemas["SandboxTemplate"];
export type IsolationClass = Schemas["IsolationClass"];
export type Sandbox = Schemas["Sandbox"];
export type ExecRequest = Schemas["ExecRequest"];
export type ExecResult = Schemas["ExecResult"];
export type SandboxErrorCode = Schemas["Error"]["code"];

/**
 * The sandbox API (contracts/openapi/sandbox.yaml) as a port. Every backend
 * (Docker, a fake, later OpenSandbox or agent-sandbox) implements it.
 */
export interface SandboxApi {
  /** Creates and starts a sandbox; it runs until it is destroyed. */
  create(template: SandboxTemplate): Promise<Sandbox>;
  /** Runs a command as the sandbox user and waits for it to finish. */
  exec(sandboxId: string, request: ExecRequest): Promise<ExecResult>;
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

export function assertAbsolutePath(path: string): void {
  if (!path.startsWith("/")) throw new SandboxError("invalid-request", `path must be absolute: ${path}`);
}

export function newSandboxId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
