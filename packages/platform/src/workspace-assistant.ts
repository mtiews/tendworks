/** A workspace's enabled assistant (ADR 0022): the chat profile it is held with, and whether it may change the workspace. */
export interface WorkspaceAssistant {
  profile: string;
  write: boolean;
}

/**
 * The chat profile a workspace assistant is held with unless the workspace names another:
 * the default the workspace schema names (contracts/schemas/workspace.schema.yaml; a test
 * keeps both equal).
 */
export const DEFAULT_WORKSPACE_ASSISTANT_PROFILE = "workspace-assistant";

/** A workspace's `spec.assistant` with the schema's defaults filled in; undefined unless it is enabled. */
export function enabledAssistant(assistant: { enabled?: boolean; profile?: string; write?: boolean } | undefined): WorkspaceAssistant | undefined {
  if (!assistant?.enabled) return undefined;
  return { profile: assistant.profile ?? DEFAULT_WORKSPACE_ASSISTANT_PROFILE, write: assistant.write ?? false };
}
