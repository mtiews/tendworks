/**
 * A workspace's enabled assistant (ADR 0022): the chat profile it is held with, whether it
 * may change the workspace, and the prefixes of the branches a writing chat may be started
 * on besides its own (ADR 0029).
 */
export interface WorkspaceAssistant {
  profile: string;
  write: boolean;
  branchPrefixes: string[];
}

/**
 * The chat profile a workspace assistant is held with unless the workspace names another:
 * the default the workspace schema names (contracts/schemas/workspace.schema.yaml; a test
 * keeps both equal).
 */
export const DEFAULT_WORKSPACE_ASSISTANT_PROFILE = "workspace-assistant";

/** A workspace's `spec.assistant` with the schema's defaults filled in; undefined unless it is enabled. */
export function enabledAssistant(
  assistant: { enabled?: boolean; profile?: string; write?: boolean; branchPrefixes?: readonly string[] } | undefined,
): WorkspaceAssistant | undefined {
  if (!assistant?.enabled) return undefined;
  return { profile: assistant.profile ?? DEFAULT_WORKSPACE_ASSISTANT_PROFILE, write: assistant.write ?? false, branchPrefixes: [...(assistant.branchPrefixes ?? [])] };
}
