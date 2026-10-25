import { emptyConfiguration } from "@tendworks/control-plane";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { API_TOKEN, renderApp, signedIn } from "./support/platform.js";

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

describe("subscriptions in the inbox", () => {
  it("lists each subscription as a card with its scope, events, channels and priority, as tend subscription list does", async () => {
    openSubscriptions();

    const list = await screen.findByRole("list", { name: "Subscriptions" });
    const cards = [...list.querySelectorAll(":scope > li")].map((card) => [card.querySelector(".card-kind")?.textContent, ...[...card.querySelectorAll("dd")].map((value) => value.textContent), card.querySelector(".card-head span:last-child")?.textContent]);
    expect(cards).toEqual([
      ["app-pushes", "run.started, run.failed", "phone, log", "1", "workspace app"],
      ["platform-state", "platform.degraded, platform.recovered", "phone", "channel default", "platform"],
    ]);
  });

  it("is a tab of the inbox", async () => {
    signedIn();
    const { user } = renderApp({ path: "/ui/notifications" });

    await user.click(await screen.findByRole("link", { name: "Subscriptions" }));

    expect(await screen.findByRole("link", { name: "Subscriptions", current: "page" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Inbox", current: "page" })).toBeTruthy();
  });

  it("says so when nothing is subscribed", async () => {
    openSubscriptions(false);

    expect(await screen.findByText(/No subscriptions/)).toBeTruthy();
  });
});
