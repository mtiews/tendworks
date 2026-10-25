import { createInMemoryAgentRuntime, emptyConfiguration, type Configuration } from "@tendworks/control-plane";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { phoneWidth, READ_TOKEN, renderApp, signedIn } from "./support/platform.js";

type AgentProfile = Configuration["agentProfiles"][number];

const profile = (name: string, spec: Partial<AgentProfile["spec"]> = {}): AgentProfile => ({
  apiVersion: "tendworks.dev/v1",
  kind: "AgentProfile",
  metadata: { name },
  spec: { harness: "fake", ...spec },
});

type Workspace = Configuration["workspaces"][number];

const workspace = (name: string, assistant?: Workspace["spec"]["assistant"]): Workspace => ({
  apiVersion: "tendworks.dev/v1",
  kind: "Workspace",
  metadata: { name },
  spec: { git: { url: `https://example.test/acme/${name}.git`, defaultBranch: "main" }, ...(assistant ? { assistant } : {}) },
});

/**
 * A platform with two chat-enabled profiles (`assistant`, `reviewer`), one without chats
 * (`developer`), and the workspace assistants' profile; workspaces `app` (read-only
 * assistant), `notes` (writing assistant, which the agent runtime has not taken up yet,
 * so it refuses it) and `site` (no assistant).
 */
function platform() {
  const agentRuntime = createInMemoryAgentRuntime({
    chatAgents: ["assistant", "reviewer", "workspace-assistant"],
    workspaces: { app: { profile: "workspace-assistant", write: false }, notes: undefined, site: undefined },
  });
  const configuration = emptyConfiguration({
    agentProfiles: [
      profile("assistant", { chat: { idleMinutes: 5 }, mcp: ["tendworks"] }),
      profile("developer"),
      profile("reviewer", { chat: {} }),
      profile("workspace-assistant", { chat: {} }),
    ],
    workspaces: [workspace("app", { enabled: true }), workspace("notes", { enabled: true, write: true }), workspace("site")],
  });
  return { agentRuntime, configuration };
}

const USD = (amount: number) => ({ amount, currency: "USD" });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

/** The chats a group of the chat list shows, by the text of each entry. */
const group = (name: string) =>
  within(screen.getByRole("list", { name }))
    .getAllByRole("link")
    .map((link) => link.textContent);

describe("chat list", () => {
  it("names chats by their first message and groups them into open and ended, with agent, workspace and cost", async () => {
    const { agentRuntime, configuration } = platform();
    const ended = await agentRuntime.startChat({ agent: "reviewer", text: "Review it" });
    agentRuntime.finishTurn(ended.id, "Looks good", USD(0.05));
    await agentRuntime.endChat(ended.id);
    const open = await agentRuntime.startChat({ workspace: "app", text: "What does the README say?" });
    agentRuntime.finishTurn(open.id, "Hi", USD(0.01));
    signedIn();
    renderApp({ path: "/ui/chats/new", agentRuntime, configuration });

    await screen.findByRole("list", { name: "Open" });

    expect(group("Open")).toEqual([expect.stringMatching(/^What does the README say\?.*workspace-assistant · app · 0\.01 USD$/)]);
    expect(group("Ended")).toEqual([expect.stringMatching(/^Review it.*reviewer · 0\.05 USD$/)]);
    expect(screen.getByRole("link", { name: /What does the README say/ }).getAttribute("href")).toBe(`/ui/chats/${open.id}`);
    expect(screen.getByRole("link", { name: "New chat" }).getAttribute("href")).toBe("/ui/chats/new");
  });

  it("shortens a long, multi-line first message in the list", async () => {
    const { agentRuntime, configuration } = platform();
    await agentRuntime.startChat({ agent: "assistant", text: `Why did the nightly run fail?\n${"And what should I change? ".repeat(10)}` });
    signedIn();
    renderApp({ path: "/ui/chats/new", agentRuntime, configuration });

    await screen.findByRole("list", { name: "Open" });

    const [entry] = group("Open");
    expect(entry).toMatch(/^Why did the nightly run fail\? And what should I change\?.*…/);
    expect(entry).not.toContain("\n");
    expect(entry!.length).toBeLessThan(200);
  });

  it("opens the newest open chat when a desktop shows the chats without one chosen, else the newest", async () => {
    const { agentRuntime, configuration } = platform();
    const old = await agentRuntime.startChat({ agent: "assistant", text: "Old question" });
    await agentRuntime.endChat(old.id);
    const open = await agentRuntime.startChat({ agent: "reviewer", text: "Open question" });
    signedIn();
    renderApp({ path: "/ui/chats", agentRuntime, configuration });

    expect(await screen.findByRole("heading", { level: 1, name: "Open question" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/ui/chats/${open.id}`);
    expect(screen.getByRole("link", { name: /Open question/ }).getAttribute("aria-current")).toBe("page");

    cleanup();
    await agentRuntime.endChat(open.id);
    renderApp({ path: "/ui/chats", agentRuntime, configuration });
    expect(await screen.findByRole("heading", { level: 1, name: "Open question" })).toBeTruthy();
  });

  it("shows the selected chat next to the list and moves between chats without losing the list", async () => {
    const { agentRuntime, configuration } = platform();
    const first = await agentRuntime.startChat({ agent: "assistant", text: "First question" });
    agentRuntime.finishTurn(first.id, "First answer", USD(0.01));
    const second = await agentRuntime.startChat({ agent: "reviewer", text: "Second question" });
    agentRuntime.finishTurn(second.id, "Second answer", USD(0.01));
    signedIn();
    const { user } = renderApp({ path: `/ui/chats/${second.id}`, agentRuntime, configuration });
    await within(await screen.findByRole("region", { name: "Conversation" })).findByText("Second answer");

    await user.click(screen.getByRole("link", { name: /First question/ }));

    expect(await screen.findByRole("heading", { level: 1, name: "First question" })).toBeTruthy();
    await within(screen.getByRole("region", { name: "Conversation" })).findByText("First answer");
    expect(screen.getByRole("link", { name: /Second question/ })).toBeTruthy();
  });

  it("filters the chats by title, agent, workspace or id", async () => {
    const { agentRuntime, configuration } = platform();
    const open = await agentRuntime.startChat({ workspace: "app", text: "What does the README say?" });
    const other = await agentRuntime.startChat({ agent: "reviewer", text: "Review it" });
    await agentRuntime.endChat(other.id);
    signedIn();
    const { user } = renderApp({ path: "/ui/chats/new", agentRuntime, configuration });
    await screen.findByRole("list", { name: "Ended" });
    const filter = screen.getByRole("searchbox", { name: "Filter chats" });

    await user.type(filter, "READme");
    expect(screen.queryByRole("list", { name: "Ended" })).toBeNull();
    expect(group("Open")).toEqual([expect.stringMatching(/^What does the README say/)]);

    await user.clear(filter);
    await user.type(filter, "reviewer");
    expect(screen.queryByRole("list", { name: "Open" })).toBeNull();
    expect(group("Ended")).toEqual([expect.stringMatching(/^Review it/)]);

    await user.clear(filter);
    await user.type(filter, open.id);
    expect(group("Open")).toHaveLength(1);

    await user.clear(filter);
    await user.type(filter, "nothing like it");
    expect(screen.getByText("No chat matches “nothing like it”.")).toBeTruthy();
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

    await agentRuntime.startChat({ agent: "assistant", text: "Hello there" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await screen.findByRole("link", { name: /Hello there/ })).toBeTruthy();
  });
});

describe("chats on a phone", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("shows the chat list on its own and the chat after it, with a way back", async () => {
    phoneWidth(true);
    const { agentRuntime, configuration } = platform();
    const chat = await agentRuntime.startChat({ agent: "assistant", text: "Is an agent running?" });
    agentRuntime.finishTurn(chat.id, "No.", USD(0.01));
    signedIn();
    const { user } = renderApp({ path: "/ui/chats", agentRuntime, configuration });

    expect(await screen.findByRole("heading", { level: 1, name: "Chats" })).toBeTruthy();
    expect(window.location.pathname).toBe("/ui/chats");
    expect(screen.queryByRole("region", { name: "Conversation" })).toBeNull();

    await user.click(await screen.findByRole("link", { name: /Is an agent running/ }));

    expect(await screen.findByRole("heading", { level: 1, name: "Is an agent running?" })).toBeTruthy();
    expect(await screen.findByRole("region", { name: "Conversation" })).toBeTruthy();
    expect(screen.queryByRole("searchbox", { name: "Filter chats" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe("/ui/chats");
  });

  it("starts a new chat from the list", async () => {
    phoneWidth(true);
    const { agentRuntime, configuration } = platform();
    signedIn();
    const { user } = renderApp({ path: "/ui/chats", agentRuntime, configuration });

    await user.click(await screen.findByRole("link", { name: "New chat" }));

    expect(await screen.findByRole("textbox", { name: "Message" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe("/ui/chats");
  });
});

const posts = (requests: Request[], path: string) => requests.filter((request) => request.method === "POST" && new URL(request.url).pathname === path);

const newChatInput = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

/** Opens the new chat form on the platform above. */
async function openNewChat() {
  const { agentRuntime, configuration } = platform();
  signedIn();
  const rendered = renderApp({ path: "/ui/chats/new", agentRuntime, configuration });
  await screen.findByRole("textbox", { name: "Message" });
  return { ...rendered, agentRuntime };
}

describe("new chat", () => {
  it("offers the profiles that allow chats except workspace assistants' profiles, and every workspace with an assistant, and starts a chat with the one chosen", async () => {
    const { agentRuntime, configuration } = platform();
    signedIn();
    const { user, platform: running } = renderApp({ path: "/ui/chats", agentRuntime, configuration });

    await user.click(await screen.findByRole("link", { name: "New chat" }));
    const chatWith = await screen.findByRole("combobox", { name: "Chat with" });
    expect(within(chatWith).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "assistant",
      "reviewer",
      "Workspace app (read-only)",
      "Workspace notes (may write)",
    ]);

    await user.selectOptions(chatWith, "Workspace app (read-only)");
    await user.type(screen.getByRole("textbox", { name: "Message" }), "What does the README say?");
    await user.click(screen.getByRole("button", { name: "Start chat" }));

    const [chat] = [...agentRuntime.chats.values()];
    expect(await screen.findByRole("heading", { level: 1, name: "What does the README say?" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/ui/chats/${chat!.id}`);
    expect(await posts(running.requests, "/chats")[0]!.json()).toEqual({ workspace: "app", text: "What does the README say?" });
    expect(chat).toMatchObject({ agent: "workspace-assistant", workspace: "app", write: false });
  });

  it("starts a chat with the platform assistant unless another is chosen", async () => {
    const { agentRuntime, configuration } = platform();
    signedIn();
    const { user, platform: running } = renderApp({ path: "/ui/chats/new", agentRuntime, configuration });

    await user.type(await screen.findByRole("textbox", { name: "Message" }), "Hello");
    await user.click(screen.getByRole("button", { name: "Start chat" }));

    await screen.findByRole("heading", { level: 1, name: "Hello" });
    expect(await posts(running.requests, "/chats")[0]!.json()).toEqual({ agent: "assistant", text: "Hello" });
  });

  it("shows why the platform refused a chat and keeps what was entered", async () => {
    const { agentRuntime, configuration } = platform();
    signedIn();
    const { user } = renderApp({ path: "/ui/chats/new", agentRuntime, configuration });

    await user.selectOptions(await screen.findByRole("combobox", { name: "Chat with" }), "Workspace notes (may write)");
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Hello");
    await user.click(screen.getByRole("button", { name: "Start chat" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Chat not allowed: workspace notes has no enabled assistant: set spec.assistant.enabled in the workspace to chat with it",
    );
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" }).value).toBe("Hello");
    expect(agentRuntime.chats.size).toBe(0);
  });

  it("starts the chat with Enter", async () => {
    const { user, platform: running } = await openNewChat();

    await user.type(newChatInput(), "Hello{Enter}");

    await screen.findByRole("heading", { level: 1, name: "Hello" });
    expect(await posts(running.requests, "/chats")[0]!.json()).toEqual({ agent: "assistant", text: "Hello" });
  });

  it("starts the chat with Ctrl+Enter", async () => {
    const { user, platform: running } = await openNewChat();

    await user.type(newChatInput(), "Hello{Control>}{Enter}{/Control}");

    await screen.findByRole("heading", { level: 1, name: "Hello" });
    expect(posts(running.requests, "/chats")).toHaveLength(1);
  });

  it("inserts a line break with Shift+Enter instead of starting the chat", async () => {
    const { user, platform: running } = await openNewChat();

    await user.type(newChatInput(), "First{Shift>}{Enter}{/Shift}second");

    expect(newChatInput().value).toBe("First\nsecond");
    expect(posts(running.requests, "/chats")).toHaveLength(0);
  });

  it("does not start the chat with the Enter that ends an input method's composition", async () => {
    const { user, platform: running } = await openNewChat();
    await user.type(newChatInput(), "日本");

    fireEvent.keyDown(newChatInput(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(newChatInput(), { key: "Enter", keyCode: 229 });
    await vi.advanceTimersByTimeAsync(100);

    expect(posts(running.requests, "/chats")).toHaveLength(0);
    expect(newChatInput().value).toBe("日本");
  });

  it("does not start a chat with an empty message, nor a second one while the first starts", async () => {
    const { user, platform: running } = await openNewChat();

    await user.type(newChatInput(), "   {Enter}");
    await vi.advanceTimersByTimeAsync(100);
    expect(posts(running.requests, "/chats")).toHaveLength(0);

    fireEvent.change(newChatInput(), { target: { value: "Hello" } });
    fireEvent.keyDown(newChatInput(), { key: "Enter" });
    fireEvent.keyDown(newChatInput(), { key: "Enter" });
    await screen.findByRole("heading", { level: 1, name: "Hello" });
    expect(posts(running.requests, "/chats")).toHaveLength(1);
  });

  it("says next to Start chat how Enter works, as the message's description", async () => {
    await openNewChat();

    expect(description(newChatInput())).toBe("Enter to send · Shift+Enter for a new line");
  });

  it("inserts a line break with Enter on a touch screen and starts the chat with the button, without the Enter hint", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)", media: query }));
    try {
      const { user, platform: running } = await openNewChat();
      expect(description(newChatInput())).toBe("");
      expect(screen.queryByText(/Enter to send/)).toBeNull();

      await user.type(newChatInput(), "First{Enter}second");
      await vi.advanceTimersByTimeAsync(100);
      expect(newChatInput().value).toBe("First\nsecond");
      expect(posts(running.requests, "/chats")).toHaveLength(0);

      await user.click(screen.getByRole("button", { name: "Start chat" }));
      await screen.findByRole("heading", { level: 1, name: "First second" });
      expect(await posts(running.requests, "/chats")[0]!.json()).toEqual({ agent: "assistant", text: "First\nsecond" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("says so when no profile allows chats", async () => {
    const { agentRuntime, configuration } = platform();
    signedIn();
    renderApp({ path: "/ui/chats/new", agentRuntime, configuration: { ...configuration, agentProfiles: [profile("developer")], workspaces: [workspace("site")] } });

    expect(
      await screen.findByText("No agent profile allows chats and no workspace has an assistant. Give a profile spec.chat or a workspace spec.assistant to chat."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start chat" })).toBeNull();
  });
});

describe("chats in read-only mode", () => {
  it("lists chats but offers no new chat", async () => {
    const { agentRuntime, configuration } = platform();
    await agentRuntime.startChat({ agent: "assistant", text: "Hello" });
    signedIn(READ_TOKEN);
    renderApp({ path: "/ui/chats", agentRuntime, configuration });

    expect(await screen.findByRole("link", { name: /Hello/ })).toBeTruthy();
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
/** The text of the elements that describe `element` (`aria-describedby`). */
const description = (element: Element) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
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

    expect(screen.getByRole("heading", { level: 1, name: "Is an agent running?" })).toBeTruthy();
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

  it("sends with Enter", async () => {
    const { user, platform: running, chat } = await openChat();

    await user.type(input(), "Next{Enter}");

    await vi.waitFor(() => expect(posts(running.requests, `/chats/${chat.id}/messages`)).toHaveLength(1));
    expect(await posts(running.requests, `/chats/${chat.id}/messages`)[0]!.json()).toEqual({ text: "Next" });
  });

  it("inserts a line break with Shift+Enter instead of sending", async () => {
    const { user, platform: running, chat } = await openChat();

    await user.type(input(), "First{Shift>}{Enter}{/Shift}second");

    expect(input().value).toBe("First\nsecond");
    expect(posts(running.requests, `/chats/${chat.id}/messages`)).toHaveLength(0);
  });

  it("does not send with the Enter that ends an input method's composition", async () => {
    const { user, platform: running, chat } = await openChat();
    await user.type(input(), "日本");

    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(posts(running.requests, `/chats/${chat.id}/messages`)).toHaveLength(0);
    expect(input().disabled).toBe(false);

    // Browsers that leave `isComposing` unset report the key as 229 while composing.
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 });
    await vi.advanceTimersByTimeAsync(100);
    expect(posts(running.requests, `/chats/${chat.id}/messages`)).toHaveLength(0);
    expect(input().value).toBe("日本");
  });

  it("says next to Send how Enter works, as the input's description", async () => {
    await openChat();

    expect(description(input())).toBe("Enter to send · Shift+Enter for a new line");
  });

  it("does not send an empty message with Enter, nor while the agent works", async () => {
    const { user, platform: running, chat } = await openChat();

    await user.type(input(), "   {Enter}");
    await vi.advanceTimersByTimeAsync(100);
    expect(posts(running.requests, `/chats/${chat.id}/messages`)).toHaveLength(0);

    await user.clear(input());
    await user.type(input(), "Next{Enter}");
    await vi.waitFor(() => expect(input().disabled).toBe(true));
    // The agent works on it: an Enter that still reaches the disabled input sends nothing.
    fireEvent.change(input(), { target: { value: "Another" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await vi.advanceTimersByTimeAsync(100);
    expect(posts(running.requests, `/chats/${chat.id}/messages`)).toHaveLength(1);
  });

  it("inserts a line break with Enter on a touch screen, whose keyboard has no Shift, and sends with the button", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)", media: query }));
    try {
      const { user, platform: running, chat } = await openChat();

      await user.type(input(), "First{Enter}second");
      await vi.advanceTimersByTimeAsync(100);
      expect(input().value).toBe("First\nsecond");
      expect(posts(running.requests, `/chats/${chat.id}/messages`)).toHaveLength(0);

      await user.click(within(conversation()).getByRole("button", { name: "Send" }));
      await vi.waitFor(() => expect(posts(running.requests, `/chats/${chat.id}/messages`)).toHaveLength(1));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("has no Enter hint on a touch screen", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)", media: query }));
    try {
      await openChat();

      expect(description(input())).toBe("");
      expect(screen.queryByText(/Enter to send/)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
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
    const chat = await agentRuntime.startChat({ workspace: "app", text: "Hello" });
    agentRuntime.finishTurn(chat.id, "Hi", USD(0.01));
    await agentRuntime.endChat(chat.id);
    signedIn();
    renderApp({ path: `/ui/chats/${chat.id}`, agentRuntime, configuration });

    expect(await within(await screen.findByRole("region", { name: "Conversation" })).findByText("Hi")).toBeTruthy();
    expect(field("Workspace")).toBe("app (read-only)");
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

/**
 * A scrolled area with layout, which jsdom lacks: the page on a phone, else the chat's
 * transcript pane. Each transcript item is 200px high under a 400px head, the viewport 600px.
 * `scrollTo` moves at once, as the browser does at the end of a smooth scroll, and both it
 * and the operator's scrolling fire `scroll`.
 */
function pageWithLayout({ reducedMotion = false, phone = false } = {}) {
  const viewport = 600;
  const root = phone ? document.documentElement : undefined;
  const height = () => 400 + 200 * document.querySelectorAll('[aria-label="Transcript"] > *').length;
  let top = 0;
  const behaviors: (ScrollBehavior | undefined)[] = [];
  // The pane is found when it is first scrolled or asked: it exists once the chat is shown.
  const target = (): HTMLElement | Window => root ?? (document.querySelector<HTMLElement>(".chat-scroll")!);
  const moveTo = (to: number) => {
    top = Math.max(0, Math.min(to, height() - viewport));
    (root ? window : target()).dispatchEvent(new Event("scroll"));
  };
  const area = root ?? (Element.prototype as HTMLElement);
  const define = (object: object, property: string, get: () => number) => Object.defineProperty(object, property, { configurable: true, get });
  define(area, "scrollHeight", height);
  define(area, "clientHeight", () => viewport);
  define(area, "scrollTop", () => top);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: (reducedMotion && query === "(prefers-reduced-motion: reduce)") || (phone && query.includes("max-width: 759")), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  const scrolled = ((options: ScrollToOptions) => {
    behaviors.push(options.behavior);
    moveTo(options.top ?? top);
  }) as typeof window.scrollTo;
  vi.spyOn(window, "scrollTo").mockImplementation(scrolled);
  vi.spyOn(Element.prototype, "scrollTo").mockImplementation(scrolled);
  return {
    /** How far the operator is from the end of the scrolled area. */
    belowView: () => height() - viewport - top,
    /** The operator scrolls to `to`. */
    scrollTo: moveTo,
    behaviors,
  };
}

describe("chat window scrolling", () => {
  afterEach(() => {
    for (const object of [document.documentElement, Element.prototype]) for (const property of ["scrollHeight", "clientHeight", "scrollTop"]) Reflect.deleteProperty(object, property);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens at the end of the history", async () => {
    const page = pageWithLayout();
    await openChat();

    expect(page.belowView()).toBe(0);
  });

  it("follows the agent's output while the operator is at or near the end", async () => {
    const page = pageWithLayout();
    const { agentRuntime, chat } = await openChat();
    // The history is three items: the page is 1000px high; the operator is 40px above its end.
    page.scrollTo(1000 - 600 - 40);

    await agentRuntime.sendChatMessage(chat.id, "From the CLI");
    agentRuntime.finishTurn(chat.id, "Answer", USD(0.02));

    await vi.waitFor(() => expect(transcriptItems().at(-1)).toBe("Waiting for the next message · turn 0.01 USD · 0.02 USD so far"));
    expect(page.belowView()).toBe(0);
    expect(page.behaviors.at(-1)).toBe("smooth");
  });

  it("leaves the operator where they scrolled up to read", async () => {
    const page = pageWithLayout();
    const { agentRuntime, chat } = await openChat();
    page.scrollTo(0);

    await agentRuntime.sendChatMessage(chat.id, "From the CLI");
    agentRuntime.finishTurn(chat.id, "Answer", USD(0.02));

    await vi.waitFor(() => expect(transcriptItems().at(-1)).toBe("Waiting for the next message · turn 0.01 USD · 0.02 USD so far"));
    expect(page.belowView()).toBe(1000 + 3 * 200 - 600);
  });

  it("goes to the end when the operator sends a message, even after scrolling up", async () => {
    const page = pageWithLayout();
    const { user } = await openChat();
    page.scrollTo(0);

    await user.type(input(), "And the last runs?");
    await user.click(within(conversation()).getByRole("button", { name: "Send" }));

    await vi.waitFor(() => expect(transcriptItems().at(-1)).toBe("And the last runs?"));
    expect(page.belowView()).toBe(0);
  });

  it("does not scroll smoothly when the operator prefers reduced motion", async () => {
    const page = pageWithLayout({ reducedMotion: true });
    const { agentRuntime, chat } = await openChat();

    await agentRuntime.sendChatMessage(chat.id, "From the CLI");

    await vi.waitFor(() => expect(transcriptItems().at(-1)).toBe("From the CLI"));
    expect(page.belowView()).toBe(0);
    expect(page.behaviors).not.toContain("smooth");
  });
});

describe("chat window scrolling on a phone", () => {
  afterEach(() => {
    for (const object of [document.documentElement, Element.prototype]) for (const property of ["scrollHeight", "clientHeight", "scrollTop"]) Reflect.deleteProperty(object, property);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("scrolls the page, not the transcript, to follow the agent's output", async () => {
    const page = pageWithLayout({ phone: true });
    const { agentRuntime, chat } = await openChat();
    expect(page.belowView()).toBe(0);

    await agentRuntime.sendChatMessage(chat.id, "From the CLI");

    await vi.waitFor(() => expect(transcriptItems().at(-1)).toBe("From the CLI"));
    expect(page.belowView()).toBe(0);
    expect(Element.prototype.scrollTo).not.toHaveBeenCalled();
  });
});
