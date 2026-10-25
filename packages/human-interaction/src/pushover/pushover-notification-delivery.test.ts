import { describe, expect, it } from "vitest";
import type { Notification } from "../notification-delivery.js";
import { describeNotificationDelivery, SUITE_NOTIFICATION } from "../notification-delivery.suite.js";
import { stubPushoverApi } from "./pushover-api.stub.js";
import { createPushoverNotificationDelivery } from "./pushover-notification-delivery.js";

const TOKEN = "azGDORePK8gMaC0QOYAMyEEuzJnyUi"; // betterleaks:allow dummy Pushover application token for the stub
const USER = "uQiRzpo4DXghDmr9QzzfQu27cmVRsG"; // betterleaks:allow dummy Pushover user key for the stub

function setup({ refuseWith, token = TOKEN }: { refuseWith?: number; token?: string } = {}) {
  const api = stubPushoverApi({ token: TOKEN, user: USER, ...(refuseWith === undefined ? {} : { refuseWith }) });
  const delivery = createPushoverNotificationDelivery({
    credentials: () => ({ token, user: USER }),
    fetch: api,
  });
  return { api, delivery };
}

describeNotificationDelivery("pushover", {
  accepting() {
    const { api, delivery } = setup();
    return { delivery, received: () => api.messages.map(({ title }) => title ?? "") };
  },
  refusing: () => setup({ token: "wrong-token" }).delivery,
});

const failed: Notification = {
  id: "9d2e-notification-failed",
  kind: "run.failed",
  runId: "run-2",
  title: "Run run-2 of develop-issue failed",
  detail: "/do/0/implement: Agent task ended in state TASK_STATE_FAILED",
  createdAt: "2026-10-18T11:00:03.000Z",
  deliveries: [],
};

describe("pushover notification delivery", () => {
  it("sends the title, the detail as message, and the notification's time", async () => {
    const { api, delivery } = setup();

    await delivery.deliver(failed);

    expect(api.messages).toEqual([
      {
        token: TOKEN,
        user: USER,
        title: "Run run-2 of develop-issue failed",
        message: "/do/0/implement: Agent task ended in state TASK_STATE_FAILED",
        timestamp: Date.parse("2026-10-18T11:00:03.000Z") / 1000,
      },
    ]);
  });

  it("links the first artifact, so a tap opens it, and lists every artifact in the message", async () => {
    const { api, delivery } = setup();

    await delivery.deliver({
      ...SUITE_NOTIFICATION,
      artifacts: [
        { name: "pull-request", url: "https://git.example/acme/app/pull/7", description: "Add the login screen" },
        { name: "preview", url: "https://preview.example/app/7" },
      ],
    });

    expect(api.messages[0]).toMatchObject({
      title: "Run run-1 of develop-issue completed",
      message: "pull-request: https://git.example/acme/app/pull/7\npreview: https://preview.example/app/7",
      url: "https://git.example/acme/app/pull/7",
      url_title: "Add the login screen",
    });
  });

  it("names the artifact as the link's title when it has no description, and sends the title as message without detail or artifacts", async () => {
    const { api, delivery } = setup();

    await delivery.deliver(SUITE_NOTIFICATION);
    await delivery.deliver({ ...SUITE_NOTIFICATION, artifacts: [] });

    expect(api.messages[0]).toMatchObject({ url: "https://git.example/acme/app/pull/7", url_title: "pull-request" });
    expect(api.messages[1]).toMatchObject({ message: "Run run-1 of develop-issue completed" });
    expect(api.messages[1]).not.toHaveProperty("url");
  });

  it("sends the priority the notifier resolved, and Pushover's default without one", async () => {
    const { api, delivery } = setup();

    await delivery.deliver(failed, { priority: 1 });
    await delivery.deliver(failed);

    expect(api.messages[0]?.priority).toBe(1);
    expect(api.messages[1]).not.toHaveProperty("priority");
  });

  it("shortens a title and message over Pushover's limits instead of losing the notification", async () => {
    const { api, delivery } = setup();

    await delivery.deliver({ ...failed, title: "t".repeat(300), detail: "d".repeat(2000) });

    expect(api.messages[0]?.title).toBe(`${"t".repeat(249)}…`);
    expect(api.messages[0]?.message).toBe(`${"d".repeat(1023)}…`);
  });

  it("leaves out a link too long for Pushover, which the message still lists", async () => {
    const { api, delivery } = setup();
    const long = `https://git.example/${"x".repeat(600)}`;

    await delivery.deliver({ ...SUITE_NOTIFICATION, artifacts: [{ name: "report", url: long }] });

    expect(api.messages[0]).not.toHaveProperty("url");
    expect(api.messages[0]?.message).toContain("report: https://git.example/");
  });

  it("reports a refused message with Pushover's status and errors, never the credentials", async () => {
    const { delivery } = setup({ token: "wrong-token" });

    const refusal = delivery.deliver(failed);

    await expect(refusal).rejects.toThrow("Pushover refused the message (HTTP 400): application token is invalid");
    await expect(refusal).rejects.not.toThrow(/wrong-token/);
  });

  it("reports a refusal over the monthly limit", async () => {
    await expect(setup({ refuseWith: 429 }).delivery.deliver(failed)).rejects.toThrow("Pushover refused the message (HTTP 429): message limit reached");
  });

  it("fails the delivery, naming the problem, when its credentials cannot be resolved", async () => {
    const delivery = createPushoverNotificationDelivery({
      credentials: () => {
        throw new Error("secret TENDWORKS_PLATFORM_PUSHOVER_TOKEN is not set");
      },
      fetch: stubPushoverApi({ token: TOKEN, user: USER }),
    });

    await expect(delivery.deliver(failed)).rejects.toThrow("secret TENDWORKS_PLATFORM_PUSHOVER_TOKEN is not set");
  });
});
