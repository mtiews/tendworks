import { createSecretResolver } from "@tendworks/platform";
import type { NotificationChannel } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { SUITE_NOTIFICATION } from "./notification-delivery.suite.js";
import { notifierChannelsFor } from "./notification-channels.js";
import { stubPushoverApi } from "./pushover/pushover-api.stub.js";

const TOKEN = "azGDORePK8gMaC0QOYAMyEEuzJnyUi"; // betterleaks:allow dummy Pushover application token for the stub
const USER = "uQiRzpo4DXghDmr9QzzfQu27cmVRsG"; // betterleaks:allow dummy Pushover user key for the stub

const channel = (name: string, spec: NotificationChannel.NotificationChannelSpec): NotificationChannel.NotificationChannel => ({
  apiVersion: "tendworks.dev/v1",
  kind: "NotificationChannel",
  metadata: { name },
  spec,
});

const phone = channel("phone", {
  integration: "pushover",
  events: ["run.failed"],
  pushover: {
    token: { secretRef: { name: "TENDWORKS_PLATFORM_PUSHOVER_TOKEN" } },
    user: { secretRef: { name: "TENDWORKS_PLATFORM_PUSHOVER_USER" } },
    priority: 1,
  },
});

describe("notification channels from configuration", () => {
  it("names each channel with the kinds it selects", () => {
    const channels = notifierChannelsFor([channel("log", { integration: "fake", events: ["run.completed", "approval.requested"] }), phone], {
      secrets: createSecretResolver("platform", {}),
      log: () => {},
    });

    expect(channels.map(({ name, events }) => [name, events])).toEqual([
      ["log", ["run.completed", "approval.requested"]],
      ["phone", ["run.failed"]],
    ]);
  });

  it("delivers through the fake channel to the log, or refuses when told to", async () => {
    const lines: string[] = [];
    const [log, refusing] = notifierChannelsFor(
      [channel("log", { integration: "fake", events: ["run.completed"] }), channel("refusing", { integration: "fake", events: ["run.completed"], fake: { refuse: true } })],
      { secrets: createSecretResolver("platform", {}), log: (line) => lines.push(line) },
    );

    await log!.delivery.deliver(SUITE_NOTIFICATION);

    expect(lines).toHaveLength(1);
    await expect(refusing!.delivery.deliver(SUITE_NOTIFICATION)).rejects.toThrow(/refuses/);
  });

  it("sends Pushover messages with the platform secrets and priority the channel names", async () => {
    const api = stubPushoverApi({ token: TOKEN, user: USER });
    const [pushover] = notifierChannelsFor([phone], {
      secrets: createSecretResolver("platform", { TENDWORKS_PLATFORM_PUSHOVER_TOKEN: TOKEN, TENDWORKS_PLATFORM_PUSHOVER_USER: USER }),
      fetch: api,
    });

    await pushover!.delivery.deliver(SUITE_NOTIFICATION);

    expect(api.messages).toEqual([expect.objectContaining({ token: TOKEN, user: USER, priority: 1, url: "https://git.example/acme/app/pull/7" })]);
  });

  it("resolves the secrets at each delivery: a missing one fails that delivery, naming it, and a later delivery finds it once it is set", async () => {
    const environment: Record<string, string> = { TENDWORKS_PLATFORM_PUSHOVER_USER: USER };
    const api = stubPushoverApi({ token: TOKEN, user: USER });
    const [pushover] = notifierChannelsFor([phone], { secrets: createSecretResolver("platform", () => environment), fetch: api });

    await expect(pushover!.delivery.deliver(SUITE_NOTIFICATION)).rejects.toThrow("secret TENDWORKS_PLATFORM_PUSHOVER_TOKEN is not set");

    environment.TENDWORKS_PLATFORM_PUSHOVER_TOKEN = TOKEN;
    await pushover!.delivery.deliver(SUITE_NOTIFICATION);
    expect(api.messages).toHaveLength(1);
  });
});
