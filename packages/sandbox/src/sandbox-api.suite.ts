import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SandboxApi, SandboxTemplate } from "./sandbox-api.js";

export interface SandboxApiSuiteContext {
  api: SandboxApi;
  /** An image present on the backend that provides busybox-style `sh`, `echo`, `cat`, `id`, `pwd`. */
  image: string;
}

/**
 * The behaviour every sandbox backend must show. Runs against the real
 * adapters and the fake, so the fake stays a faithful stand-in.
 */
export function describeSandboxApi(name: string, setup: () => Promise<SandboxApiSuiteContext> | SandboxApiSuiteContext) {
  // Concurrent: every case uses its own sandbox, which keeps real backends fast.
  describe.concurrent(`sandbox API: ${name}`, () => {
    let context: SandboxApiSuiteContext;
    const created: string[] = [];

    beforeAll(async () => {
      context = await setup();
    });

    afterAll(async () => {
      await Promise.all(created.map((id) => context.api.destroy(id)));
    });

    const template = (spec: Partial<SandboxTemplate["spec"]> = {}, templateName = "suite"): SandboxTemplate => ({
      apiVersion: "tendworks.dev/v1",
      kind: "SandboxTemplate",
      metadata: { name: templateName },
      spec: { image: context.image, ...spec },
    });

    const create = async (t: SandboxTemplate = template()) => {
      const sandbox = await context.api.create(t);
      created.push(sandbox.id);
      return sandbox;
    };

    it("creates a running sandbox from a sandbox template", async () => {
      const sandbox = await create(template({}, "node-dev"));

      expect(sandbox).toMatchObject({ template: "node-dev", isolationClass: "container", state: "running" });
      expect(sandbox.id).toMatch(/^[a-z0-9]{1,32}$/);
      expect(Date.parse(sandbox.createdAt)).not.toBeNaN();
    });

    it("runs a command and returns its output and exit code", async () => {
      const { id } = await create();

      const result = await context.api.exec(id, { command: ["echo", "hello", "sandbox"] });

      expect(result).toEqual({ exitCode: 0, stdout: "hello sandbox\n", stderr: "" });
    });

    it("reports a failing command through its exit code and stderr", async () => {
      const { id } = await create();

      const result = await context.api.exec(id, { command: ["cat", "/no/such/file"] });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("/no/such/file");
    });

    it("reports an unknown program with exit code 127", async () => {
      const { id } = await create();

      const result = await context.api.exec(id, { command: ["no-such-program"] });

      expect(result.exitCode).toBe(127);
      expect(result.stdout).toBe("");
    });

    it("runs commands as the non-root default user", async () => {
      const { id } = await create();

      const result = await context.api.exec(id, { command: ["id", "-u"] });

      expect(result.stdout).toBe("1000\n");
    });

    it("runs commands as the template's user", async () => {
      const { id } = await create(template({ user: "4242:4242" }));

      const result = await context.api.exec(id, { command: ["id", "-u"] });

      expect(result.stdout).toBe("4242\n");
    });

    it.each(["0", "0:0", "root", "1000:0", "node"])("refuses to create a sandbox whose user is %j", async (user) => {
      await expect(context.api.create(template({ user }))).rejects.toMatchObject({ code: "invalid-request" });
    });

    it("runs a command in the given working directory with the given environment", async () => {
      const { id } = await create();

      const pwd = await context.api.exec(id, { command: ["pwd"], workingDirectory: "/tmp" });
      const env = await context.api.exec(id, { command: ["printenv", "GREETING"], env: { GREETING: "moin" } });

      expect(pwd.stdout).toBe("/tmp\n");
      expect(env.stdout).toBe("moin\n");
    });

    it("writes a file that commands in the sandbox can read, creating parent directories", async () => {
      const { id } = await create();

      await context.api.writeFile(id, "/tmp/work/notes/plan.md", new TextEncoder().encode("# Plan\n"));
      const result = await context.api.exec(id, { command: ["cat", "/tmp/work/notes/plan.md"] });

      expect(result).toEqual({ exitCode: 0, stdout: "# Plan\n", stderr: "" });
    });

    it("reads back exactly the bytes written, replacing earlier content", async () => {
      const { id } = await create();
      const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256);

      await context.api.writeFile(id, "/tmp/data.bin", new TextEncoder().encode("old"));
      await context.api.writeFile(id, "/tmp/data.bin", bytes);

      expect(await context.api.readFile(id, "/tmp/data.bin")).toEqual(bytes);
    });

    it("rejects reading a file that does not exist", async () => {
      const { id } = await create();

      await expect(context.api.readFile(id, "/tmp/missing.txt")).rejects.toMatchObject({ code: "file-not-found" });
    });

    it("destroys a sandbox so it can no longer be used", async () => {
      const { id } = await create();

      await context.api.destroy(id);

      await expect(context.api.exec(id, { command: ["echo"] })).rejects.toMatchObject({ code: "sandbox-not-found" });
      await expect(context.api.readFile(id, "/tmp/x")).rejects.toMatchObject({ code: "sandbox-not-found" });
      await expect(context.api.writeFile(id, "/tmp/x", new Uint8Array())).rejects.toMatchObject({ code: "sandbox-not-found" });
    });

    it("treats destroying an unknown or already destroyed sandbox as done", async () => {
      const { id } = await create();
      await context.api.destroy(id);

      await expect(context.api.destroy(id)).resolves.toBeUndefined();
      await expect(context.api.destroy("doesnotexist")).resolves.toBeUndefined();
    });

    it("rejects ids that are not sandbox ids", async () => {
      await expect(context.api.exec("../containers/foo", { command: ["echo"] })).rejects.toMatchObject({ code: "sandbox-not-found" });
    });

    it("rejects relative file paths", async () => {
      const { id } = await create();

      await expect(context.api.writeFile(id, "notes.md", new Uint8Array())).rejects.toMatchObject({ code: "invalid-request" });
    });

    it("keeps files of different sandboxes apart", async () => {
      const first = await create();
      const second = await create();

      await context.api.writeFile(first.id, "/tmp/only-here.txt", new TextEncoder().encode("first"));

      await expect(context.api.readFile(second.id, "/tmp/only-here.txt")).rejects.toMatchObject({ code: "file-not-found" });
    });
  });
}
