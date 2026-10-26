import { createAgentRuntimeClient, createInMemoryAgentRuntime, emptyConfiguration } from "@tendworks/control-plane";
import type { AgentProfile } from "@tendworks/shared";
import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { renderApp, signedIn } from "./support/platform.js";

beforeEach(() => signedIn());

const profile = (name: string, spec: Partial<AgentProfile.AgentProfile["spec"]> = {}): AgentProfile.AgentProfile => ({
  apiVersion: "tendworks.dev/v1",
  kind: "AgentProfile",
  metadata: { name },
  spec: { harness: "fake", ...spec },
});

const card = (name: string) => within(within(screen.getByRole("list", { name: "Agent profiles" })).getByText(name).closest("li") as HTMLElement);

describe("agents page", () => {
  it("shows each agent profile with its harness, sandbox, skills and active sessions linking to their run or chat", async () => {
    const agentRuntime = createInMemoryAgentRuntime({ chatAgents: ["assistant"] });
    agentRuntime.startStep({ agent: "developer", run: "r-1", step: "/do/0/implement" });
    const chat = await agentRuntime.startChat({ agent: "assistant", text: "Hello" });
    renderApp({
      path: "/ui/agents",
      configuration: emptyConfiguration({ agentProfiles: [profile("developer", { sandbox: "node-dev", skills: ["tdd", "grill-me"] }), profile("assistant"), profile("reviewer")] }),
      agentRuntime,
    });

    await screen.findByRole("list", { name: "Agent profiles" });
    const developer = card("developer");
    expect(developer.getByText("fake")).toBeTruthy();
    expect(developer.getByText("node-dev")).toBeTruthy();
    expect([developer.getByText("tdd"), developer.getByText("grill-me")]).toHaveLength(2);
    expect(developer.getByText("1 active")).toBeTruthy();
    expect(developer.getByRole("link", { name: "run r-1 step /do/0/implement" }).getAttribute("href")).toBe("/ui/runs/r-1");
    expect(card("assistant").getByRole("link", { name: `chat ${chat.id}` }).getAttribute("href")).toBe(`/ui/chats/${chat.id}`);
    expect(card("reviewer").getByText("idle")).toBeTruthy();
    expect(card("reviewer").queryByRole("list", { name: "Sessions of reviewer" })).toBeNull();
  });

  it("shows sessions as unknown while the agent runtime is unreachable, and the profiles still", async () => {
    renderApp({
      path: "/ui/agents",
      configuration: emptyConfiguration({ agentProfiles: [profile("developer")] }),
      agentRuntime: createAgentRuntimeClient({ baseUrl: "http://agent-runtime.test", fetch: () => Promise.reject(new TypeError("fetch failed")) }),
    });

    await screen.findByRole("list", { name: "Agent profiles" });
    expect(card("developer").getByText("sessions unknown")).toBeTruthy();
    expect(screen.getByText("The agent runtime cannot be reached: which agents work right now is unknown.")).toBeTruthy();
  });
});
