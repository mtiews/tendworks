import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const composeFile = fileURLToPath(new URL("../../../deploy/compose.yaml", import.meta.url));

/**
 * The installation under test: the compose project name as compose resolves it (`-p`,
 * COMPOSE_PROJECT_NAME from the environment or deploy/.env, else `name:`). Its sandboxes,
 * session volumes and sandbox network are named after it.
 */
export const installation: string = JSON.parse(
  (await promisify(execFile)("docker", ["compose", "-f", composeFile, "config", "--format", "json"], { timeout: 60_000 })).stdout,
).name;

export const volumeOf = (volume: string) => `${installation}-volume-${volume}`;
export const sandboxNetwork = `${installation}-sandboxes`;
/** The MCP-only gateway's network (compose network platform-mcp), which sandboxes of MCP profiles join. */
export const platformMcpNetwork = `${installation}_platform-mcp`;
