import type { Sandbox } from "@tendworks/shared";

type Schemas = Sandbox.components["schemas"];

export type SandboxTemplate = Schemas["SandboxTemplate"];
export type ExecRequest = Schemas["ExecRequest"];
export type ExecResult = Schemas["ExecResult"];
export type VolumeMount = Schemas["VolumeMount"];

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
 *
 * @port
 */
export interface Sandboxes {
  /**
   * Volumes outlive the sandbox, so a later sandbox mounting them carries on with their files.
   * The owner (the task the sandbox works for) is recorded on the sandbox and its new volumes.
   * The sandbox also joins the given networks (only those the installation allows).
   */
  create(template: SandboxTemplate, options?: { volumes?: VolumeMount[]; owner?: string; networks?: string[] }): Promise<{ id: string }>;
  /** Runs a command and waits for it to finish; a non-zero exit code is not an error. */
  exec(sandboxId: string, request: ExecRequest): Promise<ExecResult>;
  attach(sandboxId: string, request: ExecRequest): Promise<SandboxProcess>;
  readFile(sandboxId: string, path: string): Promise<Uint8Array>;
  writeFile(sandboxId: string, path: string, content: Uint8Array): Promise<void>;
  /** Destroys the sandbox, but not its volumes. */
  destroy(sandboxId: string): Promise<void>;
  deleteVolume(volume: string): Promise<void>;
}
