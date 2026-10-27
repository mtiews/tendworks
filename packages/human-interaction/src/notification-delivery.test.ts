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
  it("writes the notification as one log line, its detail's lines joined, with its first artifact's link", async () => {
    const lines: string[] = [];

    await createFakeNotificationDelivery({ log: (line) => lines.push(line) }).deliver(SUITE_NOTIFICATION);

    expect(lines).toEqual([
      "notification 4f9c0a52-notification [run.completed] Completed · app/develop-issue · #7 Fix the login (pull-request: https://git.example/acme/app/pull/7; Run run-1) <https://git.example/acme/app/pull/7>",
    ]);
  });
});
