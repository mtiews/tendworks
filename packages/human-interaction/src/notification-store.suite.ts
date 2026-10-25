import { beforeEach, describe, expect, it } from "vitest";
import type { Notification } from "./notification-delivery.js";
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
      artifacts: [{ name: "pull-request", url: "https://git.example/acme/app/pull/7", description: "The change" }],
      createdAt: "2026-10-18T10:00:00.000Z",
      deliveries: [
        { channel: "phone", status: "pending" },
        { channel: "log", status: "pending" },
      ],
      ...overrides,
    });
    const cause = () => `/tendworks/test ${crypto.randomUUID()}`;

    it("returns a recorded notification as it was recorded", async () => {
      const recorded = notification();

      expect(await store.record(cause(), recorded)).toEqual(recorded);
      expect(await store.list()).toContainEqual(recorded);
    });

    it("records a notification about the platform, which has no run", async () => {
      const { runId: _, ...platformWide } = notification({ kind: "platform.degraded", title: "Platform degraded: worker" });

      expect(await store.record(cause(), platformWide)).toEqual(platformWide);
      expect(await store.list()).toContainEqual(platformWide);
    });

    it("keeps the first notification when the same event is recorded again", async () => {
      const event = cause();
      const first = notification();

      await store.record(event, first);
      const second = await store.record(event, notification({ title: "again" }));

      expect(second).toEqual(first);
      expect((await store.list()).filter((known) => known.runId === first.runId || known.title === "again")).toEqual([first]);
    });

    it("stores the outcome of a delivery attempt per channel, keeping the channels' order", async () => {
      const { detail: _detail, artifacts: _artifacts, ...bare } = notification({ kind: "approval.requested" });
      const recorded = await store.record(cause(), bare);

      await store.updateDelivery(recorded.id, { channel: "log", status: "failed", attemptedAt: "2026-10-18T10:00:01.000Z", error: "channel down" });
      await store.updateDelivery(recorded.id, { channel: "phone", status: "delivered", attemptedAt: "2026-10-18T10:00:02.000Z" });

      const stored = (await store.list()).find((known) => known.id === recorded.id);
      expect(stored?.deliveries).toEqual([
        { channel: "phone", status: "delivered", attemptedAt: "2026-10-18T10:00:02.000Z" },
        { channel: "log", status: "failed", attemptedAt: "2026-10-18T10:00:01.000Z", error: "channel down" },
      ]);
      expect(stored).not.toHaveProperty("detail");
      expect(stored).not.toHaveProperty("artifacts");
    });

    it("keeps a notification no channel selects, with no deliveries", async () => {
      const recorded = await store.record(cause(), notification({ deliveries: [] }));

      expect((await store.list()).find((known) => known.id === recorded.id)?.deliveries).toEqual([]);
    });

    it("refuses an outcome for an unknown notification or a channel it was not recorded for", async () => {
      const recorded = await store.record(cause(), notification());

      await expect(store.updateDelivery(crypto.randomUUID(), { channel: "phone", status: "delivered" })).rejects.toThrow(/unknown notification/);
      await expect(store.updateDelivery(recorded.id, { channel: "pager", status: "delivered" })).rejects.toThrow(/channel pager/);
    });

    it("lists notifications newest first, up to a limit", async () => {
      const older = await store.record(cause(), notification());
      const newer = await store.record(cause(), notification());

      expect((await store.list({ limit: 2 })).map((known) => known.id)).toEqual([newer.id, older.id]);
    });
  });
}
