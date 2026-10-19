/**
 * The name agent profiles list the platform MCP server by (`spec.mcp: [tendworks]`,
 * ADR 0016), and the name sessions know it by.
 */
export const PLATFORM_MCP_SERVER = "tendworks";

/** Whether an agent profile lists the platform MCP server in `spec.mcp`. */
export function listsPlatformMcpServer(profile: { spec: { mcp?: readonly string[] | undefined } }): boolean {
  return profile.spec.mcp?.includes(PLATFORM_MCP_SERVER) ?? false;
}
