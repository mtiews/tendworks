import { createInMemoryAgentRuntime, type Configuration } from "@tendworks/control-plane";
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READ_TOKEN, renderApp, signedIn } from "./support/platform.js";
import { rows } from "./support/table.js";

type AgentProfile = Configuration["agentProfiles"][number];

const profile = (name: string, spec: Partial<AgentProfile["spec"]> = {}): AgentProfile => ({
  apiVersion: "tendworks.dev/v1",
  kind: "AgentProfile",
  metadata: { name },
  spec: { harness: "fake", ...spec },
});

/** A platform with two chat-enabled profiles (`assistant`, `reviewer`) and one without chats (`developer`). */
function platform() {
  const agentRuntime = createInMemoryAgentRuntime({ chatAgents: ["assistant", "reviewer"] });
  const configuration = {
    workflowNames: [],
    workflow: () => undefined,
    agentProfiles: [profile("assistant", { chat: { idleMinutes: 5 }, mcp: ["tendworks"] }), profile("developer"), profile("reviewer", { chat: {} })],
    triggerBindings: [],
    policies: [],
    pullRequestIntegrations: [],
  };
  return { agentRuntime, configuration };
}

const USD = (amount: number) => ({ amount, currency: "USD" });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("chats page", () => {
  it("lists open and ended chats with profile, status, start, last activity and cost, like `tend chat list`", async () => {
    const { agentRuntime, configuration } = platform();
    const ended = await agentRuntime.startChat({ agent: "reviewer", text: "Review it" });
    agentRuntime.finishTurn(ended.id, "Looks good", USD(0.05));
    await agentRuntime.endChat(ended.id);
    const open = await agentRuntime.startChat({ agent: "assistant", text: "Hello" });
    agentRuntime.finishTurn(open.id, "Hi", USD(0.01));
    const chat = (id: string) => agentRuntime.chats.get(id)!;
    signedIn();
    renderApp({ path: "/ui/chats", agentRuntime, configuration });

    const table = await screen.findByRole("table", { name: "Chats" });
    expect(rows(table)).toEqual([
      ["Chat", "Agent", "Status", "Started", "Last activity", "Cost"],
      [open.id, "assistant", "input-required", open.startedAt, chat(open.id).lastActivityAt, "0.01 USD"],
      [ended.id, "reviewer", "ended", ended.startedAt, chat(ended.id).lastActivityAt, "0.05 USD"],
    ]);
    expect(within(table).getByRole("link", { name: open.id }).getAttribute("href")).toBe(`/ui/chats/${open.id}`);
    expect(screen.getByRole("link", { name: "New chat" }).getAttribute("href")).toBe("/ui/chats/new");
  });

  it("says when there are no chats yet, and when the agent runtime cannot be reached", async () => {
    const { agentRuntime, configuration } = platform();
    signedIn();
    const { platform: running } = renderApp({ path: "/ui/chats", agentRuntime, configuration });

    expect(await screen.findByText("No chats yet.")).toBeTruthy();

    running.restart({ configuration });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await screen.findByRole("alert")).textContent).toBe("Agent runtime unavailable (503)");
  });

  it("shows new chats by polling", async () => {
    const { agentRuntime, configuration } = platform();
    signedIn();
    renderApp({ path: "/ui/chats", agentRuntime, configuration });
    await screen.findByText("No chats yet.");

    const chat = await agentRuntime.startChat({ agent: "assistant", text: "Hello" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await screen.findByRole("link", { name: chat.id })).toBeTruthy();
  });
});

const posts = (requests: Request[], path: string) => requests.filter((request) => request.method === "POST" && new URL(request.url).pathname === path);

describe("new chat", () => {
  it("offers only the profiles that allow chats and starts a chat with the first message and a public repository", async () => {
    const { agentRuntime, configuration } = platform();
    signedIn();
    const { user, platform: running } = renderApp({ path: "/ui/chats", agentRuntime, configuration });

    await user.click(await screen.findByRole("link", { name: "New chat" }));
    const profiles = await screen.findByRole("combobox", { name: "Agent profile" });
    expect(within(profiles).getAllByRole("option").map((option) => option.textContent)).toEqual(["assistant", "reviewer"]);

    await user.selectOptions(profiles, "reviewer");
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Review the README");
    await user.type(screen.getByRole("textbox", { name: "Public repository (optional)" }), "https://example.test/acme/playground.git");
    await user.click(screen.getByRole("button", { name: "Start chat" }));

    const [chat] = [...agentRuntime.chats.values()];
    expect(await screen.findByRole("heading", { name: `Chat ${chat!.id}` })).toBeTruthy();
    expect(window.location.pathname).toBe(`/ui/chats/${chat!.id}`);
    expect(await posts(running.requests, "/chats")[0]!.json()).toEqual({ agent: "reviewer", text: "Review the README", repository: "https://example.test/acme/playground.git" });
  });

  it("starts a chat with an empty workspace when no repository is given", async () => {
    const { agentRuntime, configuration } = platform();
    signedIn();
    const { user, platform: running } = renderApp({ path: "/ui/chats/new", agentRuntime, configuration });

    await user.type(await screen.findByRole("textbox", { name: "Message" }), "Hello");
    await user.click(screen.getByRole("button", { name: "Start chat" }));

    await screen.findByRole("heading", { name: /^Chat / });
    expect(await posts(running.requests, "/chats")[0]!.json()).toEqual({ agent: "assistant", text: "Hello" });
  });

  it("shows why the platform refused a repository and keeps what was entered", async () => {
    const { agentRuntime, configuration } = platform();
    signedIn();
    const { user } = renderApp({ path: "/ui/chats/new", agentRuntime, configuration });

    await user.type(await screen.findByRole("textbox", { name: "Message" }), "Hello");
    await user.type(screen.getByRole("textbox", { name: "Public repository (optional)" }), "https://user@example.test/acme/private.git");
    await user.click(screen.getByRole("button", { name: "Start chat" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      'Invalid repository: repository "https://user@example.test/acme/private.git" is no https or http clone URL without credentials',
    );
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" }).value).toBe("Hello");
    expect(agentRuntime.chats.size).toBe(0);
  });

  it("says so when no profile allows chats", async () => {
    const { agentRuntime, configuration } = platform();
    signedIn();
    renderApp({ path: "/ui/chats/new", agentRuntime, configuration: { ...configuration, agentProfiles: [profile("developer")] } });

    expect(await screen.findByText("No agent profile allows chats. Give a profile spec.chat to chat with it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start chat" })).toBeNull();
  });
});

describe("chats in read-only mode", () => {
  it("lists chats but offers no new chat", async () => {
    const { agentRuntime, configuration } = platform();
    const chat = await agentRuntime.startChat({ agent: "assistant", text: "Hello" });
    signedIn(READ_TOKEN);
    renderApp({ path: "/ui/chats", agentRuntime, configuration });

    expect(await screen.findByRole("link", { name: chat.id })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "New chat" })).toBeNull();
  });

  it("offers no form to start a chat", async () => {
    const { agentRuntime, configuration } = platform();
    signedIn(READ_TOKEN);
    renderApp({ path: "/ui/chats/new", agentRuntime, configuration });

    expect(await screen.findByText("Read-only access cannot start chats.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start chat" })).toBeNull();
  });
});

const conversation = () => screen.getByRole("region", { name: "Conversation" });
const transcriptItems = () => [...within(conversation()).getByRole("list", { name: "Transcript" }).children].map((item) => item.textContent?.replace(/\s+/g, " ").trim());
const input = () => within(conversation()).getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
/** What a field of the chat's summary says, times as their exact timestamp. */
const field = (label: string) => {
  const value = screen.getByText(label, { selector: "dt" }).nextElementSibling!.cloneNode(true) as Element;
  for (const time of value.querySelectorAll("time")) time.replaceWith(time.getAttribute("datetime") ?? "");
  return value.textContent;
};

/** Opens the window of a chat with `assistant` that has answered its first message. */
async function openChat(token?: string) {
  const { agentRuntime, configuration } = platform();
  const chat = await agentRuntime.startChat({ agent: "assistant", text: "Is an agent running?" });
  agentRuntime.finishTurn(chat.id, "No, **none** is running.", USD(0.01));
  signedIn(token);
  const rendered = renderApp({ path: `/ui/chats/${chat.id}`, agentRuntime, configuration });
  await within(await screen.findByRole("region", { name: "Conversation" })).findByText("none");
  return { ...rendered, agentRuntime, chat };
}

describe("chat window", () => {
  it("shows the history, then the agent's output live, and takes the next message only while the agent waits", async () => {
    const { user, agentRuntime, chat } = await openChat();

    expect(screen.getByRole("heading", { name: `Chat ${chat.id}` })).toBeTruthy();
    expect(field("Agent")).toBe("assistant");
    expect(field("Status")).toBe("input-required");
    expect(transcriptItems()).toEqual(["Task for assistant: Is an agent running?", "No, none is running.", "Waiting for the next message · turn 0.01 USD · 0.01 USD so far"]);
    expect(within(conversation()).getByRole("status").textContent).toBe("Live");
    expect(input().disabled).toBe(false);

    await user.type(input(), "And the last runs?");
    await user.click(within(conversation()).getByRole("button", { name: "Send" }));

    await vi.waitFor(() => expect(transcriptItems().at(-1)).toBe("And the last runs?"));
    expect(input().disabled).toBe(true);
    expect(input().value).toBe("");
    expect(within(conversation()).getByText("The agent is working…")).toBeTruthy();
    await vi.waitFor(() => expect(field("Status")).toBe("working"));

    agentRuntime.finishTurn(chat.id, "All three succeeded.", USD(0.03));

    expect(await within(conversation()).findByText("All three succeeded.")).toBeTruthy();
    expect(transcriptItems().at(-1)).toBe("Waiting for the next message · turn 0.02 USD · 0.03 USD so far");
    await vi.waitFor(() => expect(input().disabled).toBe(false));
    await vi.waitFor(() => expect(field("Cost")).toBe("0.03 USD"));
    expect(field("Status")).toBe("input-required");
  });

  it("sends with Ctrl+Enter", async () => {
    const { user, platform: running, chat } = await openChat();

    await user.type(input(), "Next{Control>}{Enter}{/Control}");

    await vi.waitFor(() => expect(posts(running.requests, `/chats/${chat.id}/messages`)).toHaveLength(1));
    expect(await posts(running.requests, `/chats/${chat.id}/messages`)[0]!.json()).toEqual({ text: "Next" });
  });

  it("shows the platform's reason when a message is refused", async () => {
    const { user, agentRuntime, chat } = await openChat();
    // Another client's message went out a moment ago; this window has not seen it yet.
    agentRuntime.chats.get(chat.id)!.status = "working";

    await user.type(input(), "Mine");
    await user.click(within(conversation()).getByRole("button", { name: "Send" }));

    expect((await screen.findByRole("alert")).textContent).toBe(`Turn in progress: chat ${chat.id} is working on a turn`);
    expect(input().value).toBe("Mine");
  });

  it("ends the chat after a confirmation, and keeps it open when the operator cancels", async () => {
    const { user, agentRuntime, chat, platform: running } = await openChat();

    await user.click(within(conversation()).getByRole("button", { name: "End chat" }));
    const dialog = screen.getByRole("alertdialog", { name: "End this chat?" });
    expect(dialog.textContent).toContain("sandbox and volumes are removed");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(posts(running.requests, `/chats/${chat.id}/end`)).toHaveLength(0);

    await user.click(within(conversation()).getByRole("button", { name: "End chat" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "End this chat?" })).getByRole("button", { name: "End chat" }));

    expect(await within(conversation()).findByText("This chat has ended.")).toBeTruthy();
    expect(agentRuntime.chats.get(chat.id)!.status).toBe("ended");
    await vi.waitFor(() => expect(field("Status")).toBe("ended"));
    await vi.waitFor(() => expect(transcriptItems().at(-1)).toBe("Task completed"));
    expect(within(conversation()).queryByRole("textbox")).toBeNull();
    expect(within(conversation()).queryByRole("button", { name: "End chat" })).toBeNull();
    expect(within(conversation()).queryByRole("status")).toBeNull();
  });

  it("cancels the running turn and then takes the next message, with the chat still open", async () => {
    const { user, agentRuntime, chat, platform: running } = await openChat();
    expect(within(conversation()).queryByRole("button", { name: "Cancel turn" })).toBeNull();

    await user.type(input(), "Count to a million");
    await user.click(within(conversation()).getByRole("button", { name: "Send" }));
    await vi.waitFor(() => expect(transcriptItems().at(-1)).toBe("Count to a million"));

    await user.click(within(conversation()).getByRole("button", { name: "Cancel turn" }));

    await vi.waitFor(() => expect(input().disabled).toBe(false));
    expect(posts(running.requests, `/chats/${chat.id}/cancel`)).toHaveLength(1);
    expect(transcriptItems().slice(-2)).toEqual(["Turn cancelled · 0.01 USD", "Waiting for the next message · turn 0 USD · 0.01 USD so far"]);
    expect(within(conversation()).queryByRole("button", { name: "Cancel turn" })).toBeNull();
    await vi.waitFor(() => expect(field("Status")).toBe("input-required"));

    await user.type(input(), "Just to ten then");
    await user.click(within(conversation()).getByRole("button", { name: "Send" }));
    await vi.waitFor(() => expect(agentRuntime.chats.get(chat.id)!.status).toBe("working"));
    agentRuntime.finishTurn(chat.id, "1, 2, … 10", USD(0.02));
    expect(await within(conversation()).findByText("1, 2, … 10")).toBeTruthy();
  });

  it("shows the same conversation in two tabs, and either tab continues it", async () => {
    const { user, agentRuntime, chat, view, openTab } = await openChat();
    const second = openTab();
    const tab = (container: HTMLElement) => {
      const region = () => within(container).getByRole("region", { name: "Conversation" });
      return {
        items: () => [...within(region()).getByRole("list", { name: "Transcript" }).children].map((item) => item.textContent?.replace(/\s+/g, " ").trim()),
        input: () => within(region()).getByRole<HTMLTextAreaElement>("textbox", { name: "Message" }),
        send: async (text: string) => {
          await user.type(within(region()).getByRole("textbox", { name: "Message" }), text);
          await user.click(within(region()).getByRole("button", { name: "Send" }));
        },
      };
    };
    const first = tab(view.container);
    const other = tab(second.container);
    await within(second.container).findByText("none");
    expect(other.items()).toEqual(first.items());

    await first.send("From the first tab");
    await vi.waitFor(() => expect(other.items().at(-1)).toBe("From the first tab"));
    expect(other.input().disabled).toBe(true);

    agentRuntime.finishTurn(chat.id, "Answer one", USD(0.02));
    await vi.waitFor(() => expect(other.input().disabled).toBe(false));
    await vi.waitFor(() => expect(first.input().disabled).toBe(false));

    await other.send("From the second tab");
    await vi.waitFor(() => expect(first.items().at(-1)).toBe("From the second tab"));
    expect(first.input().disabled).toBe(true);
    agentRuntime.finishTurn(chat.id, "Answer two", USD(0.03));

    await vi.waitFor(() => expect(first.items().at(-1)).toBe("Waiting for the next message · turn 0.01 USD · 0.03 USD so far"));
    expect(other.items()).toEqual(first.items());
    expect(first.items().slice(-6)).toEqual([
      "From the first tab",
      "Answer one",
      "Waiting for the next message · turn 0.01 USD · 0.02 USD so far",
      "From the second tab",
      "Answer two",
      "Waiting for the next message · turn 0.01 USD · 0.03 USD so far",
    ]);
  });

  it("shows a chat ended by another client as ended, without input", async () => {
    const { agentRuntime, chat } = await openChat();
    await agentRuntime.sendChatMessage(chat.id, "From the CLI");
    await vi.waitFor(() => expect(transcriptItems().at(-1)).toBe("From the CLI"));

    await agentRuntime.endChat(chat.id);

    expect(await within(conversation()).findByText("This chat has ended.")).toBeTruthy();
    expect(within(conversation()).queryByRole("textbox")).toBeNull();
    expect(within(conversation()).queryByRole("button", { name: "Cancel turn" })).toBeNull();
    expect(transcriptItems().at(-1)).toBe("Task completed");
    await vi.waitFor(() => expect(field("Status")).toBe("ended"));
  });

  it("hides the input as soon as the transcript shows the chat ended, before the chat is read again", async () => {
    const { agentRuntime, chat, platform: running } = await openChat();
    // The platform cannot be read for a moment: only the live transcript tells.
    agentRuntime.append(chat.id, { type: "task-ended", state: "TASK_STATE_COMPLETED", message: "ended elsewhere", position: 99, time: new Date().toISOString() });
    running.unreachable(true);

    await vi.waitFor(() => expect(transcriptItems().at(-1)).toBe("Task completed"));
    expect(within(conversation()).getByText("This chat has ended.")).toBeTruthy();
    expect(within(conversation()).queryByRole("textbox")).toBeNull();
  });

  it("shows an ended chat's history without input", async () => {
    const { agentRuntime, configuration } = platform();
    const chat = await agentRuntime.startChat({ agent: "assistant", text: "Hello", repository: "https://example.test/acme/playground.git" });
    agentRuntime.finishTurn(chat.id, "Hi", USD(0.01));
    await agentRuntime.endChat(chat.id);
    signedIn();
    renderApp({ path: `/ui/chats/${chat.id}`, agentRuntime, configuration });

    expect(await within(await screen.findByRole("region", { name: "Conversation" })).findByText("Hi")).toBeTruthy();
    expect(field("Repository")).toBe("https://example.test/acme/playground.git");
    expect(field("Ended")).toBe(agentRuntime.chats.get(chat.id)!.endedAt);
    expect(within(conversation()).getByText("This chat has ended.")).toBeTruthy();
    expect(within(conversation()).queryByRole("textbox")).toBeNull();
  });

  it("says when there is no such chat", async () => {
    const { agentRuntime, configuration } = platform();
    signedIn();
    renderApp({ path: "/ui/chats/no-such-chat", agentRuntime, configuration });

    expect(await screen.findByText("There is no chat no-such-chat.")).toBeTruthy();
  });

  it("shows the chat live in read-only mode, without input or end", async () => {
    const { agentRuntime, chat } = await openChat(READ_TOKEN);

    expect(within(conversation()).getByText("Read-only access: you can follow this chat but not write to it.")).toBeTruthy();
    expect(within(conversation()).queryByRole("textbox")).toBeNull();
    expect(within(conversation()).queryByRole("button", { name: "End chat" })).toBeNull();

    await agentRuntime.sendChatMessage(chat.id, "From the CLI");
    expect(await within(conversation()).findByText("From the CLI")).toBeTruthy();
  });
});
