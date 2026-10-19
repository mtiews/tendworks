import { beforeEach, describe, expect, it } from "vitest";
import type { Notification } from "./notification-channel.js";
import type { NotificationStore } from "./notification-store.js";

/**
 * The behaviour every notification store must show. Runs against the real adapter and
 * the fake, so the fake stays a faithful stand-in.
 */
export function describeNotificationStore(name: string, setup: () => Promise<NotificationStore> | NotificationStore) {
  describe(`notification store: ${name}`, () => {
    let store: NotificationStore;

    beforeEach(async () => {
      store = await setup();
    });

    const notification = (overrides: Partial<Notification> = {}): Notification => ({
      id: crypto.randomUUID(),
      kind: "run.failed",
      runId: crypto.randomUUID(),
      title: "Run of hello-agent failed",
      detail: "/do/0/implement: Agent task failed",
      createdAt: "2026-10-18T10:00:00.000Z",
      delivery: { status: "pending" },
      ...overrides,
    });
    const cause = () => `/tendworks/test ${crypto.randomUUID()}`;

    it("returns a recorded notification as it was recorded", async () => {
      const recorded = notification();

      expect(await store.record(cause(), recorded)).toEqual(recorded);
      expect(await store.list()).toContainEqual(recorded);
    });

    it("keeps the first notification when the same event is recorded again", async () => {
      const event = cause();
      const first = notification();

      await store.record(event, first);
      const second = await store.record(event, notification({ title: "again" }));

      expect(second).toEqual(first);
      expect((await store.list()).filter((known) => known.runId === first.runId || known.title === "again")).toEqual([first]);
    });

    it("stores the outcome of a delivery attempt", async () => {
      const { detail: _detail, ...withoutDetail } = notification({ kind: "run.completed" });
      const recorded = await store.record(cause(), withoutDetail);

      await store.updateDelivery(recorded.id, { status: "failed", attemptedAt: "2026-10-18T10:00:01.000Z", error: "channel down" });

      const stored = (await store.list()).find((known) => known.id === recorded.id);
      expect(stored?.delivery).toEqual({ status: "failed", attemptedAt: "2026-10-18T10:00:01.000Z", error: "channel down" });
      expect(stored).not.toHaveProperty("detail");
    });

    it("lists notifications newest first, up to a limit", async () => {
      const older = await store.record(cause(), notification());
      const newer = await store.record(cause(), notification());

      expect((await store.list({ limit: 2 })).map((known) => known.id)).toEqual([newer.id, older.id]);
    });
  });
}
