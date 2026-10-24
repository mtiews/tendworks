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

/**
 * Why a workspace's spec (ADR 0022) cannot be used beyond what its schema checks, or
 * undefined when it can: a directory must resolve strictly under one of `roots`
 * ({@link resolveWorkspaceDirectory}), and git credentials are only sent over `https://`
 * (without credentials, `http://` and `file:///` are fine). Both configuration loaders
 * call it, so server and worker refuse the same workspaces at startup.
 */
export function workspaceProblem(
  spec: { git?: { url: string } | undefined; directory?: { path: string } | undefined; credentials?: unknown },
  roots: readonly string[],
): string | undefined {
  if (spec.git && spec.credentials !== undefined && !spec.git.url.startsWith("https://")) {
    return `credentials need an https:// URL, but git.url is ${spec.git.url}; the credential would leave the sandbox unencrypted or go nowhere`;
  }
  const resolved = spec.directory ? resolveWorkspaceDirectory(spec.directory.path, roots) : undefined;
  return resolved && "problem" in resolved ? resolved.problem : undefined;
}

/** The path functions {@link isStrictlyUnder} compares with: Node's for this host (default), or `posix` for paths of a Linux host. */
export type PathFlavor = Pick<typeof posix, "relative" | "isAbsolute" | "sep">;

const NATIVE: PathFlavor = { relative, isAbsolute, sep };

/**
 * Whether `path` lies strictly under `root`, lexically: inside it and not the root itself,
 * after resolving `..`. Shared by the workspace roots check, the directory claims of the
 * agent runtime and the sandbox adapter's bind check (with `posix`, for host paths).
 */
export function isStrictlyUnder(path: string, root: string, flavor: PathFlavor = NATIVE): boolean {
  const rest = flavor.relative(root, path);
  return rest !== "" && rest !== ".." && !rest.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(rest);
}
