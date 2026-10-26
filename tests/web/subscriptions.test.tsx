import { emptyConfiguration } from "@tendworks/control-plane";
import { screen, within } from "@testing-library/react";
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
    const cards = [...list.querySelectorAll(":scope > li")].map((card) => [
      within(card as HTMLElement).getAllByRole("term").map((term) => `${term.textContent}: ${[...(term.nextElementSibling?.childNodes ?? [])].map((node) => node.textContent).join(", ")}`),
      card.textContent,
    ]);
    expect(cards).toEqual([
      [["Events: run.started, run.failed", "Channels: phone, log", "Priority: 1"], expect.stringMatching(/^app-pushesworkspace app/)],
      [["Events: platform.degraded, platform.recovered", "Channels: phone", "Priority: channel default"], expect.stringMatching(/^platform-stateplatform/)],
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
