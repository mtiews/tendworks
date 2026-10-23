import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SandboxError, type SandboxApi, type SandboxTemplate } from "./sandbox-api.js";

// The sandbox API contract (contracts/openapi/sandbox.yaml). The port has no HTTP binding
// yet, so the suite checks what every backend answers against the contract's schemas.
const contracts = new URL("../../../contracts/", import.meta.url);
const SANDBOX_CONTRACT = "https://tendworks.dev/schemas/v1/openapi/sandbox.yaml";
const ajv = new Ajv2020({ strict: false, validateFormats: false })
  .addSchema(JSON.parse(readFileSync(new URL("schemas/sandbox-template.schema.json", contracts), "utf8")))
  .addSchema(parse(readFileSync(new URL("openapi/sandbox.yaml", contracts), "utf8")), SANDBOX_CONTRACT);
const violations = (schema: string, value: unknown) => {
  const validate = ajv.getSchema(`${SANDBOX_CONTRACT}#/components/schemas/${schema}`)!;
  return validate(value) ? [] : validate.errors;
};

export interface SandboxApiSuiteContext {
  api: SandboxApi;
  /** An image present on the backend that provides busybox-style `sh`, `echo`, `cat`, `id`, `pwd`. */
  image: string;
  /** The same backend as `api`, but serving another installation. */
  neighbour: SandboxApi;
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
    const volumes: string[] = [];

    beforeAll(async () => {
      context = await setup();
    });

    afterAll(async () => {
      await Promise.all(created.map((id) => context.api.destroy(id)));
      await Promise.all(volumes.map((volume) => context.api.deleteVolume(volume)));
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

    it("answers in the shapes of the sandbox API contract", async () => {
      const sandbox = await create();
      const result = await context.api.exec(sandbox.id, { command: ["echo", "contract"] });
      const process = await context.api.attach(sandbox.id, { command: ["echo"] });
      await process.exited;
      const error = await context.api.readFile(sandbox.id, "/tmp/missing.txt").catch((caught: unknown) => caught);

      expect(violations("Sandbox", sandbox)).toEqual([]);
      expect(violations("ExecResult", result)).toEqual([]);
      expect(violations("ProcessId", process.id)).toEqual([]);
      expect(error).toBeInstanceOf(SandboxError);
      const { code, message } = error as SandboxError;
      expect(violations("Error", { code, message })).toEqual([]);
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

    it("attaches to a running process: stdin goes in, stdout comes out while it runs", async () => {
      const { id } = await create();
      const process = await context.api.attach(id, { command: ["cat"] });
      const stdin = process.stdin.getWriter();
      const stdout = lines(process.stdout);

      await stdin.write(encode("first line\n"));
      expect(await stdout.next()).toBe("first line");
      await stdin.write(encode("second line\n"));
      expect(await stdout.next()).toBe("second line");
      await stdin.close();

      expect(await process.exited).toBe(0);
      expect(await stdout.next()).toBeUndefined();
    });

    it("hands an attached process its environment and working directory", async () => {
      const { id } = await create();

      const env = await context.api.attach(id, { command: ["printenv", "GREETING"], env: { GREETING: "moin" } });
      const pwd = await context.api.attach(id, { command: ["pwd"], workingDirectory: "/tmp" });

      expect(await text(env.stdout)).toBe("moin\n");
      expect(await text(pwd.stdout)).toBe("/tmp\n");
      expect(await env.exited).toBe(0);
    });

    it("reports stderr and the exit code of an attached process", async () => {
      const { id } = await create();

      const process = await context.api.attach(id, { command: ["cat", "/no/such/file"] });

      expect(await text(process.stderr)).toContain("/no/such/file");
      expect(await process.exited).toBe(1);
    });

    it("reports an attached program that does not exist with exit code 127", async () => {
      const { id } = await create();

      const process = await context.api.attach(id, { command: ["no-such-program"] });
      await process.stdout.cancel();

      expect(await process.exited).toBe(127);
    });

    it("rejects attaching to an unknown sandbox", async () => {
      await expect(context.api.attach("doesnotexist", { command: ["cat"] })).rejects.toMatchObject({ code: "sandbox-not-found" });
    });

    // Volumes are mounted on /tmp: it exists in every image and the sandbox user may write
    // there, and an empty volume takes over the ownership of the directory it is mounted on.
    const volumeName = () => `suite-${crypto.randomUUID()}`;
    const withVolume = async (volume: string) => {
      const sandbox = await context.api.create(template(), { volumes: [{ volume, path: "/tmp" }] });
      created.push(sandbox.id);
      return sandbox;
    };

    it("keeps the files of a volume for a later sandbox that mounts it", async () => {
      const volume = volumeName();
      volumes.push(volume);
      const first = await withVolume(volume);
      await context.api.writeFile(first.id, "/tmp/work/progress.md", encode("half done\n"));
      await context.api.destroy(first.id);

      const second = await withVolume(volume);

      expect(new TextDecoder().decode(await context.api.readFile(second.id, "/tmp/work/progress.md"))).toBe("half done\n");
      const listed = await context.api.exec(second.id, { command: ["cat", "/tmp/work/progress.md"] });
      expect(listed.stdout).toBe("half done\n");
      await context.api.writeFile(second.id, "/tmp/work/progress.md", encode("done\n"));
    });

    it("keeps different volumes apart", async () => {
      const [a, b] = [volumeName(), volumeName()];
      volumes.push(a, b);
      const first = await withVolume(a);
      await context.api.writeFile(first.id, "/tmp/only-in-a.txt", encode("a"));

      const second = await withVolume(b);

      await expect(context.api.readFile(second.id, "/tmp/only-in-a.txt")).rejects.toMatchObject({ code: "file-not-found" });
    });

    it("deletes a volume with its files, also when it is unknown", async () => {
      const volume = volumeName();
      const first = await withVolume(volume);
      await context.api.writeFile(first.id, "/tmp/gone.txt", encode("gone"));
      await context.api.destroy(first.id);

      await context.api.deleteVolume(volume);
      await expect(context.api.deleteVolume(volume)).resolves.toBeUndefined();

      const second = await withVolume(volume);
      volumes.push(volume);
      await expect(context.api.readFile(second.id, "/tmp/gone.txt")).rejects.toMatchObject({ code: "file-not-found" });
    });

    it("refuses to delete a volume a sandbox still uses", async () => {
      const volume = volumeName();
      volumes.push(volume);
      await withVolume(volume);

      await expect(context.api.deleteVolume(volume)).rejects.toMatchObject({ code: "volume-in-use" });
    });

    it("lists its sandboxes with their owner until they are destroyed", async () => {
      const owned = await context.api.create(template({}, "listed"), { owner: "task-4711" });
      created.push(owned.id);
      const unowned = await create();

      const listed = await context.api.list();

      expect(violations("Sandbox", owned)).toEqual([]);
      for (const sandbox of listed) expect(violations("Sandbox", sandbox)).toEqual([]);
      expect(listed.find(({ id }) => id === owned.id)).toMatchObject({ template: "listed", state: "running", owner: "task-4711" });
      expect(listed.find(({ id }) => id === unowned.id)).not.toHaveProperty("owner");

      await context.api.destroy(owned.id);
      expect((await context.api.list()).map(({ id }) => id)).not.toContain(owned.id);
    });

    it("lists the volumes its sandboxes created, with the sandbox's owner, until they are deleted", async () => {
      const volume = volumeName();
      const sandbox = await context.api.create(template(), { volumes: [{ volume, path: "/tmp" }], owner: "task-0815" });
      await context.api.destroy(sandbox.id);

      const listed = await context.api.listVolumes();

      for (const entry of listed) expect(violations("Volume", entry)).toEqual([]);
      expect(listed).toContainEqual({ name: volume, owner: "task-0815" });

      await context.api.deleteVolume(volume);
      expect((await context.api.listVolumes()).map(({ name }) => name)).not.toContain(volume);
    });

    it("neither lists nor reaches nor deletes what another installation on the same backend has", async () => {
      const { neighbour } = context;
      const volume = volumeName();
      const theirs = await neighbour.create(template(), { volumes: [{ volume, path: "/tmp" }], owner: "their-task" });
      try {
        await neighbour.writeFile(theirs.id, "/tmp/theirs.txt", encode("theirs"));

        expect((await context.api.list()).map(({ id }) => id)).not.toContain(theirs.id);
        expect((await context.api.listVolumes()).map(({ name }) => name)).not.toContain(volume);
        await expect(context.api.exec(theirs.id, { command: ["echo"] })).rejects.toMatchObject({ code: "sandbox-not-found" });
        await context.api.destroy(theirs.id);
        expect(new TextDecoder().decode(await neighbour.readFile(theirs.id, "/tmp/theirs.txt"))).toBe("theirs");

        await neighbour.destroy(theirs.id);
        await context.api.deleteVolume(volume);
        expect((await neighbour.listVolumes()).map(({ name }) => name)).toContain(volume);
      } finally {
        await neighbour.destroy(theirs.id);
        await neighbour.deleteVolume(volume);
      }
    });

    it("keeps files of different sandboxes apart", async () => {
      const first = await create();
      const second = await create();

      await context.api.writeFile(first.id, "/tmp/only-here.txt", new TextEncoder().encode("first"));

      await expect(context.api.readFile(second.id, "/tmp/only-here.txt")).rejects.toMatchObject({ code: "file-not-found" });
    });
  });
}

const encode = (value: string) => new TextEncoder().encode(value);

/** Reads a whole stream as UTF-8. */
async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  let result = "";
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) result += chunk;
  return result;
}

/** Reads a stream line by line; `next()` resolves with undefined at its end. */
function lines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return {
    async next(): Promise<string | undefined> {
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          return line;
        }
        const { value, done } = await reader.read();
        if (done) return buffer === "" ? undefined : buffer;
        buffer += value;
      }
    },
  };
}
