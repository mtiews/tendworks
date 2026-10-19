import type { A2A } from "@tendworks/shared";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "./chat-events.js";
import type { StoredTask, TaskStore } from "./task-store.js";

export interface TaskStoreSuiteContext {
  store: TaskStore;
  /** Events the store published with its writes, oldest first. */
  published(): Promise<ChatEvent[]>;
}

/**
 * The behaviour every task store must show. Runs against the real adapter and the
 * fake, so the fake stays a faithful stand-in.
 */
export function describeTaskStore(name: string, setup: () => Promise<TaskStoreSuiteContext> | TaskStoreSuiteContext) {
  describe(`task store: ${name}`, () => {
    let store: TaskStore;
    let published: () => Promise<ChatEvent[]>;

    beforeEach(async () => {
      ({ store, published } = await setup());
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
      const loser = claims[0].task.id === a.task.id ? b : a;
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

    it("keeps the harness session of a task and returns it to later claims", async () => {
      const first = candidate();
      await store.claim(first);

      await store.saveSession(first.task.id, { sessionId: "session-1" });
      await store.saveSession(first.task.id, { sessionId: "session-1", sandboxId: "sandbox1" });

      expect(await store.claim(candidate(first.messageId))).toEqual({ ...first, session: { sessionId: "session-1", sandboxId: "sandbox1" } });
    });

    const event = (type: "started" | "ended", chatId: string): ChatEvent =>
      ({
        specversion: "1.0",
        id: `${chatId}:chat.${type}`,
        source: "/tendworks/test",
        subject: `chats/${chatId}`,
        type: `dev.tendworks.chat.${type}`,
        time: "2026-10-18T10:00:00.000Z",
        datacontenttype: "application/json",
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        data: type === "started" ? { agent: "echo" } : { agent: "echo", status: "ended" },
      }) as ChatEvent;

    it("publishes the event of a claim with a new task, and none when the message has a task already", async () => {
      const chat = { ...candidate(), kind: "chat" as const };
      const before = (await published()).length;

      await store.claim(chat, event("started", chat.task.id));
      await store.claim({ ...candidate(chat.messageId), kind: "chat" }, event("started", "other"));

      expect((await published()).slice(before)).toEqual([event("started", chat.task.id)]);
    });

    it("publishes the event of an update with it", async () => {
      const chat = { ...candidate(), kind: "chat" as const };
      await store.claim(chat);
      const before = (await published()).length;

      await store.update({ ...chat.task, status: { state: "TASK_STATE_COMPLETED" } }, event("ended", chat.task.id));

      expect((await published()).slice(before)).toEqual([event("ended", chat.task.id)]);
    });

    it("lists the tasks of a kind, the most recently started first", async () => {
      const at = (startedAt: string) => ({ ...candidate(), kind: "chat" as const, startedAt });
      const older = at("2026-10-18T09:00:00.000Z");
      const newer = at("2026-10-18T11:00:00.000Z");
      await store.claim(older);
      await store.claim(newer);
      const other = candidate();
      await store.claim(other);

      const listed = (await store.list({ kind: "chat" })).map((task) => task.id);

      expect(listed.indexOf(newer.task.id)).toBeGreaterThanOrEqual(0);
      expect(listed.indexOf(newer.task.id)).toBeLessThan(listed.indexOf(older.task.id));
      expect(listed).not.toContain(other.task.id);
    });

    it("finds a task as it is kept, with its kind and harness session", async () => {
      const chat = { ...candidate(), kind: "chat" as const };
      await store.claim(chat);
      await store.saveSession(chat.task.id, { sessionId: "session-1" });

      expect(await store.find(chat.task.id)).toEqual({ ...chat, session: { sessionId: "session-1" } });
      expect(await store.find("unknown-task")).toBeUndefined();
    });

    it("refuses to keep a session for a task it does not know", async () => {
      await expect(store.saveSession("unknown-task", { sessionId: "session-1" })).rejects.toThrow(/no such task/);
    });
  });
}
