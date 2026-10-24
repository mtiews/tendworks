import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkspaceRoots, resolveWorkspaceDirectory } from "./workspace-roots.js";

/** A root with the directories `app` and `app/sub`, a file, and a directory outside it. */
function host() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "tend-roots-")));
  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(join(root, "app", "sub"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "notes.txt"), "not a directory");
  // Junctions on Windows need no privilege; elsewhere the type is ignored.
  symlinkSync(outside, join(root, "escape"), "junction");
  symlinkSync(join(root, "app"), join(root, "alias"), "junction");
  return { base, root, outside };
}

describe("resolveWorkspaceDirectory", () => {
  it("resolves a directory under a root to its real path", () => {
    const { root } = host();

    expect(resolveWorkspaceDirectory(join(root, "app"), [root])).toEqual({ directory: join(root, "app") });
    expect(resolveWorkspaceDirectory(join(root, "app", "sub"), ["/elsewhere", root])).toEqual({ directory: join(root, "app", "sub") });
  });

  it("follows a symbolic link that stays under the root", () => {
    const { root } = host();

    expect(resolveWorkspaceDirectory(join(root, "alias"), [root])).toEqual({ directory: join(root, "app") });
  });

  it("refuses a path outside every root, also through '..' or a symbolic link out of the root", () => {
    const { root, outside } = host();

    for (const path of [outside, join(root, "app", "..", "..", "outside"), join(root, "escape"), `${root}-sibling`]) {
      expect(resolveWorkspaceDirectory(path, [root]), path).toEqual({ problem: expect.stringContaining("not under a workspace root") });
    }
  });

  it("refuses the root itself, relative paths, missing paths and files", () => {
    const { root } = host();

    expect(resolveWorkspaceDirectory(root, [root])).toEqual({ problem: expect.stringContaining("not under a workspace root") });
    expect(resolveWorkspaceDirectory("app", [root])).toEqual({ problem: expect.stringContaining("must be absolute") });
    expect(resolveWorkspaceDirectory(join(root, "missing"), [root])).toEqual({ problem: expect.stringContaining("does not exist") });
    expect(resolveWorkspaceDirectory(join(root, "notes.txt"), [root])).toEqual({ problem: expect.stringContaining("is not a directory") });
  });

  it("refuses every directory when no root is allowed", () => {
    const { root } = host();

    expect(resolveWorkspaceDirectory(join(root, "app"), [])).toEqual({ problem: expect.stringContaining("TEND_WORKSPACE_ROOTS allows no directory workspaces") });
  });
});

describe("parseWorkspaceRoots", () => {
  it("reads absolute paths separated by colons, ignoring empty entries", () => {
    expect(parseWorkspaceRoots("/srv/work::/home/op/src/")).toEqual(["/srv/work", "/home/op/src"]);
    expect(parseWorkspaceRoots(undefined)).toEqual([]);
    expect(parseWorkspaceRoots("")).toEqual([]);
  });

  it("refuses a root that is not absolute or is the file system root", () => {
    expect(() => parseWorkspaceRoots("/srv/work:relative")).toThrow("TEND_WORKSPACE_ROOTS: relative is not an absolute path");
    expect(() => parseWorkspaceRoots("/")).toThrow("TEND_WORKSPACE_ROOTS: / cannot be a workspace root");
  });
});
