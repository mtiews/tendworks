import { createInMemoryAgentRuntime, emptyConfiguration, type Configuration } from "@tendworks/control-plane";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { phoneWidth, READ_TOKEN, renderApp, signedIn } from "./support/platform.js";

type Workspace = Configuration["workspaces"][number];

const workspace = (name: string, spec: Partial<Workspace["spec"]> = {}): Workspace => ({
  apiVersion: "tendworks.dev/v1",
  kind: "Workspace",
  metadata: { name },
  spec: { git: { url: `https://example.test/acme/${name}.git`, defaultBranch: "main" }, ...spec },
});

const platform = () => ({
  agentRuntime: createInMemoryAgentRuntime({
    chatAgents: ["assistant", "workspace-assistant"],
    workspaces: { app: { profile: "workspace-assistant", write: false }, notes: { profile: "workspace-assistant", write: true }, site: undefined },
  }),
  configuration: emptyConfiguration({
    agentProfiles: [
      { apiVersion: "tendworks.dev/v1", kind: "AgentProfile", metadata: { name: "assistant" }, spec: { harness: "fake", chat: {} } },
      { apiVersion: "tendworks.dev/v1", kind: "AgentProfile", metadata: { name: "workspace-assistant" }, spec: { harness: "fake", chat: {} } },
    ],
    workspaces: [workspace("app", { assistant: { enabled: true } }), workspace("notes", { assistant: { enabled: true, write: true } }), workspace("site")],
  }),
});

const card = (name: string) => within(within(screen.getByRole("list", { name: "Workspaces" })).getByText(name).closest("li")!);

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "matchMedia");
});

describe("workspaces page", () => {
  it("shows each workspace with its kind and assistant", async () => {
    signedIn();
    renderApp({ path: "/ui/workspaces", ...platform() });

    await screen.findByRole("list", { name: "Workspaces" });
    expect(card("app").getByText("git")).toBeTruthy();
    expect(card("app").getByText("workspace-assistant (read-only)")).toBeTruthy();
    expect(card("notes").getByText("workspace-assistant (may write)")).toBeTruthy();
    expect(card("site").getByText("none")).toBeTruthy();
  });

  it("offers a chat with the assistant of workspaces that have one, opening the new chat with that workspace chosen", async () => {
    signedIn();
    const { user } = renderApp({ path: "/ui/workspaces", ...platform() });

    await screen.findByRole("list", { name: "Workspaces" });
    expect(card("site").queryByRole("link")).toBeNull();
    await user.click(card("notes").getByRole("link", { name: "Chat with the assistant of notes" }));

    const chatWith = await screen.findByRole<HTMLSelectElement>("combobox", { name: "Chat with" });
    expect(chatWith.selectedOptions[0]?.textContent).toBe("Workspace notes (may write)");
  });

  it("works on a phone as well", async () => {
    signedIn();
    phoneWidth(true);
    renderApp({ path: "/ui/workspaces", ...platform() });

    await screen.findByRole("list", { name: "Workspaces" });
    expect(card("app").getByRole("link", { name: "Chat with the assistant of app" })).toBeTruthy();
  });

  it("offers no chat in read-only mode", async () => {
    signedIn(READ_TOKEN);
    renderApp({ path: "/ui/workspaces", ...platform() });

    await screen.findByRole("list", { name: "Workspaces" });
    expect(screen.queryByRole("link", { name: /Chat with/ })).toBeNull();
  });
});
