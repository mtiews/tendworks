import type { Sandbox } from "@tendworks/shared";

type Schemas = Sandbox.components["schemas"];

export type SandboxTemplate = Schemas["SandboxTemplate"];
export type ExecRequest = Schemas["ExecRequest"];

/** A process in a sandbox with its standard streams open. */
export interface SandboxProcess {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}

/**
 * What the agent runtime needs from the sandbox API (contracts/openapi/sandbox.yaml).
 * The worker wires the sandbox domain's implementation in; errors carry the contract's
 * error `code`, e.g. `file-not-found`.
 */
export interface Sandboxes {
  create(template: SandboxTemplate): Promise<{ id: string }>;
  attach(sandboxId: string, request: ExecRequest): Promise<SandboxProcess>;
  readFile(sandboxId: string, path: string): Promise<Uint8Array>;
  writeFile(sandboxId: string, path: string, content: Uint8Array): Promise<void>;
  destroy(sandboxId: string): Promise<void>;
}
