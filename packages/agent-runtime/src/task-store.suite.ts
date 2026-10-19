import type { A2A } from "@tendworks/shared";
import { beforeEach, describe, expect, it } from "vitest";
import type { StoredTask, TaskStore } from "./task-store.js";

/**
 * The behaviour every task store must show. Runs against the real adapter and the
 * fake, so the fake stays a faithful stand-in.
 */
export function describeTaskStore(name: string, setup: () => Promise<TaskStore> | TaskStore) {
  describe(`task store: ${name}`, () => {
    let store: TaskStore;

    beforeEach(async () => {
      store = await setup();
    });

    const candidate = (messageId: string = crypto.randomUUID()): StoredTask => ({
      messageId,
      agent: "echo",
      startedAt: "2026-10-18T10:00:00.000Z",
      task: {
        id: crypto.randomUUID(),
        contextId: "context-1",
        status: { state: "TASK_STATE_WORKING", timestamp: "2026-10-18T10:00:00.000Z" },
        history: [{ messageId, role: "ROLE_USER", parts: [{ text: "Say hello" }] }],
      },
    });

    it("records a task for a new message and finds it by id", async () => {
      const first = candidate();

      expect(await store.claim(first)).toEqual(first);
      expect(await store.get(first.task.id)).toEqual(first.task);
      expect(await store.get("unknown-task")).toBeUndefined();
    });

    it("keeps the first task of a message and returns it for every later claim", async () => {
      const messageId = crypto.randomUUID();
      const [a, b] = [candidate(messageId), candidate(messageId)];

      const claims = await Promise.all([store.claim(a), store.claim(b)]);
      const later = await store.claim(candidate(messageId));

      expect(claims[1]).toEqual(claims[0]);
      expect(later).toEqual(claims[0]);
      const loser = claims[0]!.task.id === a.task.id ? b : a;
      expect(await store.get(loser.task.id)).toBeUndefined();
    });

    it("returns the latest state of a task to later claims", async () => {
      const first = candidate();
      await store.claim(first);
      const done: A2A.Task = {
        ...first.task,
        status: { state: "TASK_STATE_COMPLETED", timestamp: "2026-10-18T10:01:00.000Z" },
        artifacts: [{ artifactId: "a-1", parts: [{ text: "hello" }] }],
        metadata: { "dev.tendworks/resumed": 1 },
      };

      await store.update(done);

      expect(await store.get(first.task.id)).toEqual(done);
      expect(await store.claim(candidate(first.messageId))).toEqual({ ...first, task: done });
    });

    it("refuses to update a task it does not know", async () => {
      await expect(store.update(candidate().task)).rejects.toThrow(/no such task/);
    });
  });
}
