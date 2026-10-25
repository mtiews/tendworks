import { emptyConfiguration } from "@tendworks/control-plane";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { API_TOKEN, renderApp, signedIn } from "./support/platform.js";
import { rows } from "./support/table.js";

function openSubscriptions(subscriptions = true) {
  window.sessionStorage.setItem("tendworks.token", API_TOKEN);
  const configuration = emptyConfiguration(
    subscriptions
      ? {
          subscriptions: [
            { apiVersion: "tendworks.dev/v1", kind: "Subscription", metadata: { name: "app-pushes" }, spec: { scope: { workspace: "app" }, events: ["run.started", "run.failed"], channels: ["phone", "log"], priority: 1 } },
            { apiVersion: "tendworks.dev/v1", kind: "Subscription", metadata: { name: "platform-state" }, spec: { scope: { platform: {} }, events: ["platform.degraded", "platform.recovered"], channels: ["phone"] } },
          ],
        }
      : {},
  );
  return renderApp({ path: "/ui/subscriptions", configuration });
}

describe("subscriptions page", () => {
  it("lists each subscription with its scope, events, channels and priority, as tend subscription list does", async () => {
    openSubscriptions();

    const table = await screen.findByRole("table", { name: "Subscriptions" });
    expect(rows(table)).toEqual([
      ["Name", "Scope", "Events", "Channels", "Priority"],
      ["app-pushes", "workspace app", "run.started, run.failed", "phone, log", "1"],
      ["platform-state", "platform", "platform.degraded, platform.recovered", "phone", "channel default"],
    ]);
  });

  it("is reached from More", async () => {
    signedIn();
    const { user } = renderApp({ path: "/ui/more" });

    await user.click(await screen.findByRole("link", { name: "Subscriptions" }));

    expect(await screen.findByRole("heading", { name: "Subscriptions" })).toBeTruthy();
  });

  it("says so when nothing is subscribed", async () => {
    openSubscriptions(false);

    expect(await screen.findByText(/No subscriptions/)).toBeTruthy();
  });
});
