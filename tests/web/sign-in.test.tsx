import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { API_TOKEN, READ_TOKEN, renderApp } from "./support/platform.js";

async function signIn(user: ReturnType<typeof renderApp>["user"], token: string, { remember = false } = {}) {
  await user.type(screen.getByLabelText("API token"), token);
  if (remember) await user.click(screen.getByLabelText("Stay signed in on this device"));
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("signing in", () => {
  it("signs in with the API token and shows full access and the navigation", async () => {
    const { user } = renderApp();

    await signIn(user, API_TOKEN);

    expect(await screen.findByText("Full access")).toBeTruthy();
    const navigation = screen.getByRole("navigation", { name: "Main" });
    expect([...navigation.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Status", "/ui/"],
      ["Runs", "/ui/runs"],
      ["Approval requests", "/ui/approval-requests"],
      ["Notifications", "/ui/notifications"],
      ["Chats", "/ui/chats"],
    ]);
  });

  it("signs in with the read-only token and shows that the UI only reads", async () => {
    const { user } = renderApp();

    await signIn(user, READ_TOKEN);

    expect(await screen.findByText("Read-only")).toBeTruthy();
    expect(screen.queryByText("Full access")).toBeNull();
  });

  it("says when a token is not accepted, keeps the operator on sign-in and stores nothing", async () => {
    const { user } = renderApp();

    await signIn(user, "not-the-token");

    expect((await screen.findByRole("alert")).textContent).toBe("This token is not accepted. Check it and try again.");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect([window.sessionStorage.length, window.localStorage.length]).toEqual([0, 0]);
  });

  it("says when the platform cannot be reached", async () => {
    const { user, platform } = renderApp();
    platform.unreachable(true);

    await signIn(user, API_TOKEN);

    expect((await screen.findByRole("alert")).textContent).toBe("Cannot reach the platform. Is it running?");
  });

  it("sends the token only as a bearer token, never in a URL", async () => {
    const { user, platform } = renderApp();

    await signIn(user, API_TOKEN);
    await screen.findByText("Full access");

    expect(platform.requests.length).toBeGreaterThan(0);
    for (const request of platform.requests) {
      expect(request.url).not.toContain(API_TOKEN);
      expect(request.headers.get("authorization")).toBe(`Bearer ${API_TOKEN}`);
    }
    expect(window.location.href).not.toContain(API_TOKEN);
  });

  it("opens a deep link after sign-in", async () => {
    const { user } = renderApp({ path: "/ui/chats" });

    await signIn(user, API_TOKEN);

    expect(await screen.findByRole("heading", { name: "Chats" })).toBeTruthy();
    expect(window.location.pathname).toBe("/ui/chats");
  });
});

describe("staying signed in", () => {
  it("forgets the token with the tab by default", async () => {
    const first = renderApp();
    await signIn(first.user, API_TOKEN);
    await screen.findByText("Full access");
    first.view.unmount();

    // A new tab: the session's storage is gone.
    window.sessionStorage.clear();
    renderApp();

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("keeps the token on this device when asked to, and signs in with it when the app opens again", async () => {
    const first = renderApp();
    await signIn(first.user, READ_TOKEN, { remember: true });
    await screen.findByText("Read-only");
    first.view.unmount();

    window.sessionStorage.clear();
    renderApp({ path: "/ui/runs" });

    expect(await screen.findByText("Read-only")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Runs" })).toBeTruthy();
  });

  it("signs out and forgets the token on this device", async () => {
    const first = renderApp();
    await signIn(first.user, API_TOKEN, { remember: true });
    await first.user.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    first.view.unmount();
    renderApp();
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect([window.sessionStorage.length, window.localStorage.length]).toEqual([0, 0]);
  });
});

describe("a token that is no longer accepted", () => {
  it("returns to sign-in with a message on the next request", async () => {
    const { user, platform } = renderApp();
    await signIn(user, API_TOKEN, { remember: true });
    await screen.findByText("Full access");

    platform.restart({ apiToken: "a-new-api-token-xxxx" });
    await user.click(screen.getByRole("link", { name: "Runs" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Your token is no longer accepted. Sign in again.");
    expect([window.sessionStorage.length, window.localStorage.length]).toEqual([0, 0]);
  });

  it("returns to sign-in when a kept token is refused as the app opens", async () => {
    window.localStorage.setItem("tendworks.token", "an-old-api-token-xxxx");
    renderApp();

    expect((await screen.findByRole("alert")).textContent).toBe("Your token is no longer accepted. Sign in again.");
  });

  it("offers to try again when the platform cannot be reached as the app opens", async () => {
    window.sessionStorage.setItem("tendworks.token", API_TOKEN);
    const { user, platform } = renderApp({ unreachable: true });

    await user.click(await screen.findByRole("button", { name: "Try again" }));
    platform.unreachable(false);
    await user.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Full access")).toBeTruthy();
  });
});

describe("the app shell", () => {
  it("navigates between the views in place, with the browser's history", async () => {
    const { user } = renderApp();
    await signIn(user, API_TOKEN);

    await user.click(await screen.findByRole("link", { name: "Notifications" }));

    expect(screen.getByRole("heading", { name: "Notifications" })).toBeTruthy();
    expect(window.location.pathname).toBe("/ui/notifications");
    expect(screen.getByRole("link", { name: "Notifications" }).getAttribute("aria-current")).toBe("page");
    expect(document.title).toBe("Notifications · Tendworks");
  });

  it("says when there is no page at an address", async () => {
    const { user } = renderApp({ path: "/ui/no-such-page" });
    await signIn(user, API_TOKEN);

    expect(await screen.findByRole("heading", { name: "Not found" })).toBeTruthy();
  });
});
