import type { A2A } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { createSandboxCleanup, type CleanupSandboxes } from "./sandbox-cleanup.js";
import { createInMemoryTaskStore, type TaskKind, type TaskStore } from "./task-store.js";

/** The sandboxes and volumes of one installation in memory; a delete can be made to fail. */
function backend() {
  const sandboxes = new Map<string, { owner?: string; volumes: string[] }>();
  const volumes = new Map<string, { owner?: string }>();
  const failing = new Set<string>();
  const calls: string[] = [];
  const api: CleanupSandboxes = {
    async list() {
      return [...sandboxes].map(([id, { owner }]) => ({ id, ...(owner === undefined ? {} : { owner }) }));
    },
    async listVolumes() {
      return [...volumes].map(([name, { owner }]) => ({ name, ...(owner === undefined ? {} : { owner }) }));
    },
    async destroy(sandboxId) {
      calls.push(`destroy ${sandboxId}`);
      if (failing.has(sandboxId)) throw new Error(`backend refused to destroy ${sandboxId}`);
      sandboxes.delete(sandboxId);
    },
    async deleteVolume(volume) {
      calls.push(`delete ${volume}`);
      if (failing.has(volume)) throw new Error(`backend refused to delete ${volume}`);
      if ([...sandboxes.values()].some((sandbox) => sandbox.volumes.includes(volume))) {
        throw Object.assign(new Error(`volume ${volume} is mounted by a sandbox`), { code: "volume-in-use" });
      }
      volumes.delete(volume);
    },
  };
  /** A sandbox of the harness's kind: owned by a task, with the task's two volumes. */
  const session = (sandboxId: string, owner: string | undefined, volumeOwner = owner) => {
    const names = [`${volumeOwner}-workspace`, `${volumeOwner}-session`];
    sandboxes.set(sandboxId, { ...(owner === undefined ? {} : { owner }), volumes: names });
    for (const name of names) volumes.set(name, owner === undefined ? {} : { owner });
  };
  return { api, sandboxes, volumes, failing, calls, session };
}

async function claim(store: TaskStore, state: A2A.TaskState, kind: TaskKind = "task"): Promise<string> {
  const id = crypto.randomUUID();
  await store.claim({ messageId: crypto.randomUUID(), agent: "developer", startedAt: new Date().toISOString(), kind, task: { id, status: { state } } });
  return id;
}

function logged() {
  const lines: string[] = [];
  return { lines, log: { info: (line: string) => lines.push(line), error: (line: string) => lines.push(`ERROR ${line}`) } };
}

describe("sandbox clean-up", () => {
  it("removes the sandbox and volumes of an ended task and of an unknown owner, and logs each removal", async () => {
    const store = createInMemoryTaskStore();
    const ended = await claim(store, "TASK_STATE_COMPLETED");
    const unknown = crypto.randomUUID();
    const sandboxes = backend();
    sandboxes.session("sandbox1", ended);
    sandboxes.session("sandbox2", unknown);
    const { lines, log } = logged();

    await createSandboxCleanup({ sandboxes: sandboxes.api, store, log }).run();

    expect([...sandboxes.sandboxes.keys()]).toEqual([]);
    expect([...sandboxes.volumes.keys()]).toEqual([]);
    expect(lines.sort()).toEqual(
      [
        `sandbox clean-up: removed sandbox sandbox1 of ${ended}, which is no live task or open chat`,
        `sandbox clean-up: removed sandbox sandbox2 of ${unknown}, which is no live task or open chat`,
        `sandbox clean-up: removed volume ${ended}-workspace of ${ended}, which is no live task or open chat`,
        `sandbox clean-up: removed volume ${ended}-session of ${ended}, which is no live task or open chat`,
        `sandbox clean-up: removed volume ${unknown}-workspace of ${unknown}, which is no live task or open chat`,
        `sandbox clean-up: removed volume ${unknown}-session of ${unknown}, which is no live task or open chat`,
      ].sort(),
    );
  });

  it("keeps the sandboxes and volumes of a working task and of open chats", async () => {
    const store = createInMemoryTaskStore();
    const working = await claim(store, "TASK_STATE_WORKING");
    const waiting = await claim(store, "TASK_STATE_INPUT_REQUIRED", "chat");
    const sandboxes = backend();
    sandboxes.session("sandbox1", working);
    sandboxes.session("sandbox2", waiting);
    // An idle chat has let its sandbox go, its volumes stay.
    sandboxes.volumes.set(`${waiting}-extra`, { owner: waiting });
    const { lines, log } = logged();

    await createSandboxCleanup({ sandboxes: sandboxes.api, store, log }).run();

    expect([...sandboxes.sandboxes.keys()]).toEqual(["sandbox1", "sandbox2"]);
    expect(sandboxes.volumes.size).toBe(5);
    expect(lines).toEqual([]);
  });

  it("destroys sandboxes before it deletes their volumes", async () => {
    const store = createInMemoryTaskStore();
    const ended = await claim(store, "TASK_STATE_FAILED");
    const sandboxes = backend();
    sandboxes.session("sandbox1", ended);

    await createSandboxCleanup({ sandboxes: sandboxes.api, store, log: logged().log }).run();

    expect(sandboxes.calls[0]).toBe("destroy sandbox1");
    expect(sandboxes.volumes.size).toBe(0);
  });

  it("finds the owner of a volume from before owners were recorded by its name, and removes ownerless sandboxes", async () => {
    const store = createInMemoryTaskStore();
    const working = await claim(store, "TASK_STATE_WORKING");
    const ended = await claim(store, "TASK_STATE_COMPLETED");
    const sandboxes = backend();
    // Created by a worker that recorded no owners: nobody can reattach to these sandboxes any more.
    sandboxes.session("sandbox1", undefined, working);
    sandboxes.session("sandbox2", undefined, ended);
    sandboxes.volumes.set("not-of-a-task", {});

    await createSandboxCleanup({ sandboxes: sandboxes.api, store, log: logged().log }).run();

    expect([...sandboxes.sandboxes.keys()]).toEqual([]);
    expect([...sandboxes.volumes.keys()].sort()).toEqual([`${working}-session`, `${working}-workspace`, "not-of-a-task"]);
  });

  it("reports a failed removal in the log and as an unhealthy component, and retries it with the next pass", async () => {
    const store = createInMemoryTaskStore();
    const ended = await claim(store, "TASK_STATE_COMPLETED");
    const sandboxes = backend();
    sandboxes.session("sandbox1", ended);
    sandboxes.failing.add("sandbox1");
    const { lines, log } = logged();
    const cleanup = createSandboxCleanup({ sandboxes: sandboxes.api, store, log });

    await cleanup.run();
    const afterFailure = await cleanup.check();
    sandboxes.failing.delete("sandbox1");
    await cleanup.run();

    expect(lines).toContain(`ERROR sandbox clean-up: cannot remove sandbox sandbox1 of ${ended}: backend refused to destroy sandbox1; the next pass retries it`);
    expect(lines.filter((line) => line.startsWith("ERROR") && line.includes("volume"))).toHaveLength(2);
    expect(cleanup.name).toBe("sandbox-cleanup");
    expect(afterFailure).toEqual({ status: "unhealthy", message: expect.stringContaining("3 removals failed in the last pass") });
    expect(afterFailure).toMatchObject({ message: expect.stringContaining("backend refused to destroy sandbox1") });
    expect(await cleanup.check()).toEqual({ status: "healthy" });
    expect(sandboxes.sandboxes.size + sandboxes.volumes.size).toBe(0);
  });

  it("reports a pass that cannot list the installation's resources", async () => {
    const sandboxes = backend();
    sandboxes.api.list = () => Promise.reject(new Error("sandbox backend unreachable"));
    const { lines, log } = logged();
    const cleanup = createSandboxCleanup({ sandboxes: sandboxes.api, store: createInMemoryTaskStore(), log });

    await cleanup.run();

    expect(lines).toEqual(["ERROR sandbox clean-up: the pass failed: sandbox backend unreachable; the next pass retries it"]);
    expect(await cleanup.check()).toEqual({ status: "unhealthy", message: "the last pass failed: sandbox backend unreachable" });
  });

  it("keeps what a task claimed during the pass creates, since it lists before it looks for live tasks", async () => {
    const store = createInMemoryTaskStore();
    const sandboxes = backend();
    let claimed: string | undefined;
    const listing = sandboxes.api.listVolumes;
    sandboxes.api.listVolumes = async () => {
      const listed = await listing();
      // A task starts after the listing: it is claimed, then its sandbox is created.
      claimed = await claim(store, "TASK_STATE_WORKING");
      sandboxes.session("sandbox1", claimed);
      return listed;
    };

    await createSandboxCleanup({ sandboxes: sandboxes.api, store, log: logged().log }).run();

    expect(claimed).toBeDefined();
    expect([...sandboxes.sandboxes.keys()]).toEqual(["sandbox1"]);
    expect(sandboxes.volumes.size).toBe(2);
  });

  it("runs a pass on start and then periodically, removing an orphan created while it runs", async () => {
    const store = createInMemoryTaskStore();
    const sandboxes = backend();
    sandboxes.session("sandbox1", crypto.randomUUID());
    const cleanup = createSandboxCleanup({ sandboxes: sandboxes.api, store, log: logged().log, intervalMs: 20 });

    cleanup.start();
    await until(() => sandboxes.sandboxes.size === 0);
    sandboxes.session("sandbox2", crypto.randomUUID());
    await until(() => sandboxes.sandboxes.size === 0 && sandboxes.volumes.size === 0);
    await cleanup.stop();
    sandboxes.session("sandbox3", crypto.randomUUID());
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect([...sandboxes.sandboxes.keys()]).toEqual(["sandbox3"]);
  });

  it("never runs two passes at once", async () => {
    const store = createInMemoryTaskStore();
    const sandboxes = backend();
    let listing = 0;
    let most = 0;
    const list = sandboxes.api.list;
    sandboxes.api.list = async () => {
      most = Math.max(most, ++listing);
      await new Promise((resolve) => setTimeout(resolve, 20));
      listing--;
      return list();
    };
    const cleanup = createSandboxCleanup({ sandboxes: sandboxes.api, store, log: logged().log });

    await Promise.all([cleanup.run(), cleanup.run(), cleanup.run()]);

    expect(most).toBe(1);
  });
});

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !condition(); await new Promise((resolve) => setTimeout(resolve, 5))) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
  }
}
