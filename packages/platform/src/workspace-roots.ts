import { realpathSync, statSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

// Directory workspaces (ADR 0022) may only lie under the roots the operator allows in
// TEND_WORKSPACE_ROOTS. The check runs where the roots are visible at the paths the
// sandbox host knows them by (the compose stack mounts them read-only into server and
// worker at the same path), so `..` and symbolic links resolve against the real file system.

export class WorkspaceRootsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRootsError";
  }
}

/**
 * The workspace roots of `TEND_WORKSPACE_ROOTS`: absolute paths on the (Linux) sandbox host, separated by `:`.
 * Throws a {@link WorkspaceRootsError} for a relative path or the file system root, which would allow every directory.
 */
export function parseWorkspaceRoots(value: string | undefined): string[] {
  const roots = (value ?? "").split(":").filter((root) => root !== "");
  return roots.map((root) => {
    if (!posix.isAbsolute(root)) throw new WorkspaceRootsError(`TEND_WORKSPACE_ROOTS: ${root} is not an absolute path`);
    const normalized = posix.normalize(root).replace(/(.)\/+$/, "$1");
    if (normalized === "/") throw new WorkspaceRootsError(`TEND_WORKSPACE_ROOTS: ${root} cannot be a workspace root`);
    return normalized;
  });
}

/**
 * The real path of a directory workspace's `path` if it is a directory strictly under one
 * of `roots`, after resolving `..` and symbolic links (of the path and of the roots);
 * otherwise why it is refused. The root itself is refused: it would expose every other
 * workspace under it.
 */
export function resolveWorkspaceDirectory(path: string, roots: readonly string[]): { directory: string } | { problem: string } {
  if (!isAbsolute(path)) return { problem: `directory ${path} must be absolute` };
  if (roots.length === 0) return { problem: `directory ${path}: TEND_WORKSPACE_ROOTS allows no directory workspaces` };
  const outside = { problem: `directory ${path} is not under a workspace root (TEND_WORKSPACE_ROOTS: ${roots.join(":")})` };
  // Lexically first, so `..` cannot leave a root even where the real file system differs.
  if (!roots.some((root) => isStrictlyUnder(resolve(path), resolve(root)))) return outside;
  let directory: string;
  try {
    directory = realpathSync.native(path);
  } catch {
    return { problem: `directory ${path} does not exist, or the workspace roots are not mounted at the same path` };
  }
  if (!statSync(directory).isDirectory()) return { problem: `${path} is not a directory` };
  const realRoots = roots.flatMap((root) => {
    try {
      return [realpathSync.native(root)];
    } catch {
      return []; // a root that does not exist allows nothing
    }
  });
  return realRoots.some((root) => isStrictlyUnder(directory, root)) ? { directory } : outside;
}

function isStrictlyUnder(path: string, root: string): boolean {
  const rest = relative(root, path);
  return rest !== "" && rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}
