import { describe, expect, it } from "vitest";
import { createFakeNotificationDelivery } from "./notification-delivery.js";
import { describeNotificationDelivery, SUITE_NOTIFICATION } from "./notification-delivery.suite.js";

describeNotificationDelivery("fake", {
  accepting() {
    const delivery = createFakeNotificationDelivery({ log: () => {} });
    return { delivery, received: () => delivery.delivered.map(({ id }) => id) };
  },
  refusing: () => createFakeNotificationDelivery({ refuse: true, log: () => {} }),
});

describe("fake notification delivery", () => {
  it("writes the notification as one log line, with its first artifact's link", async () => {
    const lines: string[] = [];

    await createFakeNotificationDelivery({ log: (line) => lines.push(line) }).deliver({ ...SUITE_NOTIFICATION, detail: "all green" });

    expect(lines).toEqual([
      "notification 4f9c0a52-notification [run.completed] Run run-1 of develop-issue completed (all green) <https://git.example/acme/app/pull/7>",
    ]);
  });
});
