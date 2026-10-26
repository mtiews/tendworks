import { createControlPlaneApi, createInMemoryAgentRuntime, createInMemoryRuns, emptyConfiguration } from "@tendworks/control-plane";
import { describe, expect, it, vi } from "vitest";
import { runTend } from "./tend.js";

/** Lines the operator types, one after another; the iterator waits for each until it is typed. */
function keyboard() {
  const typed: string[] = [];
  const waiting: ((result: IteratorResult<string>) => void)[] = [];
  let closed = false;
  const iterator: AsyncIterableIterator<string> = {
    [Symbol.asyncIterator]: () => iterator,
    next: () =>
      new Promise((resolve) => {
        const line = typed.shift();
        if (line !== undefined) resolve({ done: false, value: line });
        else if (closed) resolve({ done: true, value: undefined });
        else waiting.push(resolve);
      }),
    async return() {
      closed = true;
      return { done: true, value: undefined };
    },
  };
  return {
    lines: () => iterator,
    type(line: string) {
      const next = waiting.shift();
      if (next) next({ done: false, value: line });
      else typed.push(line);
    },
    close() {
      closed = true;
      waiting.splice(0).forEach((resolve) => resolve({ done: true, value: undefined }));
    },
  };
}

/**
 * The control plane with a fake agent runtime whose agent answers each message in turn once
 * a client follows the chat's transcript, so the answer arrives live, or never (`"never"`),
 * so a turn runs until it is cancelled. `tend` runs
 * one client against it, with its own keyboard and Ctrl+C.
 */
function platform(answers: string[] | "never" = []) {
  const agentRuntime = createInMemoryAgentRuntime({
    chatAgents: ["assistant", "workspace-assistant"],
    workspaces: { app: { profile: "workspace-assistant", write: false }, docs: undefined },
  });
  const api = createControlPlaneApi({
    agentRuntime,
    probes: [],
    configuration: emptyConfiguration(),
    apiToken: "test-token",
    runs: createInMemoryRuns(),
  });
  // Chats whose transcript a client follows, and the answers waiting for one to.
  const followed = new Set<string>();
  const unanswered = new Set<string>();
  const answer = (id: string) => {
    unanswered.delete(id);
    agentRuntime.finishTurn(id, (answers as string[]).shift() ?? "…", { amount: 0.01, currency: "USD" });
  };
  const fetch = async (request: Request) => {
    const { pathname } = new URL(request.url);
    const response = await api.fetch(request);
    if (answers === "never" || response.status >= 300) return response;
    const stream = /^\/chats\/([^/]+)\/transcript\/stream$/.exec(pathname);
    if (request.method === "GET" && stream) {
      // The client follows the transcript from here on: an answer waiting for it arrives live.
      followed.add(stream[1]!);
      if (unanswered.has(stream[1]!)) answer(stream[1]!);
    } else if (request.method === "POST" && (pathname === "/chats" || pathname.endsWith("/messages"))) {
      const { id } = (await response.clone().json()) as { id: string };
      if (followed.has(id)) answer(id);
      else unanswered.add(id);
    }
    return response;
  };
  function tend(args: string[]) {
    const input = keyboard();
    const interrupted = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    const exitCode = runTend(["--token", "test-token", ...args], {
      fetch,
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
      sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
      lines: input.lines,
      interrupts: (onInterrupt) => {
        interrupted.add(onInterrupt);
        return () => interrupted.delete(onInterrupt);
      },
    });
    /** The operator presses Ctrl+C. */
    const interrupt = () => interrupted.forEach((onInterrupt) => onInterrupt());
    return { exitCode, input, interrupt, out: () => stdout, err: () => stderr };
  }
  return { agentRuntime, tend };
}

/** `tend chat` against the control plane with a fake agent runtime whose agent answers each message in turn. */
function chat(args: string[], answers: string[] | "never") {
  const { agentRuntime, tend } = platform(answers);
  return { ...tend(["chat", ...args]), agentRuntime };
}

/** A chat started directly through the fake agent runtime, waiting for the next message after `turns` answers. */
async function existingChat(agentRuntime: ReturnType<typeof platform>["agentRuntime"], ...turns: string[]) {
  const chat = await agentRuntime.startChat({ agent: "assistant", text: "Hello" });
  turns.forEach((reply, index) => {
    if (index > 0) void agentRuntime.sendChatMessage(chat.id, `Message ${index + 1}`);
    agentRuntime.finishTurn(chat.id, reply, { amount: 0.01 * (index + 1), currency: "USD" });
  });
  return chat.id;
}

const until = (condition: () => boolean) => vi.waitFor(() => expect(condition()).toBe(true));

describe("tend chat", () => {
  it("starts a chat with the first line, streams the agent's answers and sends each further line", async () => {
    const { exitCode, input, agentRuntime, out } = chat(["assistant"], ["Hi, I am the assistant.", "Two runs are active."]);

    await until(() => out().includes("> "));
    input.type("Hello");
    await until(() => out().includes("Hi, I am the assistant."));
    input.type("What is running?");
    await until(() => out().includes("Two runs are active."));
    input.close();

    expect(await exitCode).toBe(0);
    expect(out()).toMatch(/chat \S+ with assistant/);
    expect(out()).toMatch(/agent\s+Hi, I am the assistant\./);
    expect(out()).toMatch(/agent\s+Two runs are active\./);
    expect(out()).toContain("0.01 USD");
    const [chatted] = agentRuntime.chats.values();
    expect(chatted?.status).toBe("input-required");
    expect(out()).toContain(`left chat ${chatted!.id}; it stays open`);
  });

  it("ends the chat with /end", async () => {
    const { exitCode, input, agentRuntime, out } = chat(["assistant"], ["Hi."]);

    await until(() => out().includes("> "));
    input.type("Hello");
    await until(() => out().includes("Hi."));
    input.type("/end");

    expect(await exitCode).toBe(0);
    const [ended] = agentRuntime.chats.values();
    expect(ended?.status).toBe("ended");
    expect(out()).toContain(`chat ${ended!.id} ended`);
  });

  it("refuses a profile that does not allow chats, with the reason", async () => {
    const { exitCode, input, err, out } = chat(["developer"], []);

    await until(() => out().includes("> "));
    input.type("Push to main");

    expect(await exitCode).toBe(1);
    expect(err()).toContain("does not allow chats");
  });

  it("cancels the running turn on Ctrl+C; the chat stays open and takes the next line", async () => {
    const { exitCode, input, interrupt, agentRuntime, out } = chat(["assistant"], "never");
    await until(() => out().includes("> "));
    input.type("Work forever");
    await until(() => out().includes("chat "));
    const [started] = agentRuntime.chats.values();

    interrupt();
    await until(() => agentRuntime.chats.get(started!.id)?.status === "input-required" && out().endsWith("> "));
    input.type("Something quick instead");
    await until(() => agentRuntime.chats.get(started!.id)?.status === "working");
    agentRuntime.finishTurn(started!.id, "Done quickly.");
    await until(() => out().includes("Done quickly."));
    input.close();

    expect(await exitCode).toBe(0);
    expect(out()).toMatch(/turn\s+cancelled/);
  });

  it("leaves the chat open on Ctrl+C while the agent waits for the next message", async () => {
    const { exitCode, input, interrupt, agentRuntime, out } = chat(["assistant"], ["Hi."]);
    await until(() => out().includes("> "));
    input.type("Hello");
    await until(() => out().includes("Hi.") && out().endsWith("> "));

    interrupt();

    expect(await exitCode).toBe(0);
    const [chatted] = agentRuntime.chats.values();
    expect(chatted?.status).toBe("input-required");
    expect(out()).toContain(`left chat ${chatted!.id}; it stays open`);
  });

  it("chats with the platform assistant without arguments", async () => {
    const { exitCode, input, agentRuntime, out } = chat([], ["Two runs are active."]);

    await until(() => out().includes("> "));
    input.type("What is running?");
    await until(() => out().includes("Two runs are active."));
    input.close();

    expect(await exitCode).toBe(0);
    const [started] = agentRuntime.chats.values();
    expect(started?.agent).toBe("assistant");
    expect(out()).toMatch(/chat \S+ with assistant;/);
  });

  it("chats with a workspace's assistant with --workspace, and says that it is read-only", async () => {
    const { exitCode, input, agentRuntime, out } = chat(["--workspace", "app"], ["It has a README."]);

    await until(() => out().includes("> "));
    input.type("What is in the workspace?");
    await until(() => out().includes("It has a README."));
    input.close();

    expect(await exitCode).toBe(0);
    const [started] = agentRuntime.chats.values();
    expect(started).toMatchObject({ agent: "workspace-assistant", workspace: "app", write: false });
    expect(out()).toMatch(/chat \S+ with workspace-assistant on workspace app \(read-only\);/);
  });

  it("refuses a workspace without an enabled assistant with the reason", async () => {
    const { exitCode, input, agentRuntime, err, out } = chat(["--workspace", "docs"], []);

    await until(() => out().includes("> "));
    input.type("Hello");

    expect(await exitCode).toBe(1);
    expect(err()).toMatch(/tend: workspace docs has no enabled assistant/);
    expect(agentRuntime.chats.size).toBe(0);
  });

  it("refuses a profile together with --workspace before anything starts", async () => {
    const { exitCode, agentRuntime, err } = chat(["assistant", "--workspace", "app"], []);

    expect(await exitCode).toBe(1);
    expect(err()).toMatch(/tend: .*either a profile or --workspace/);
    expect(agentRuntime.chats.size).toBe(0);
  });

  it("leaves without starting a chat when nothing was typed", async () => {
    const { exitCode, input, agentRuntime, out } = chat(["assistant"], []);

    await until(() => out().includes("> "));
    input.close();

    expect(await exitCode).toBe(0);
    expect(agentRuntime.chats.size).toBe(0);
  });
});

describe("tend chat list, get and end", () => {
  it("lists chats with title, profile, workspace, status, start, last activity and cost", async () => {
    const { agentRuntime, tend } = platform();
    const id = await existingChat(agentRuntime, "Hi.");
    const inWorkspace = await agentRuntime.startChat({ workspace: "app", text: "Hello" });

    const { exitCode, out } = tend(["chat", "list"]);

    expect(await exitCode).toBe(0);
    expect(out()).toMatch(/^ID\s+TITLE\s+AGENT\s+WORKSPACE\s+STATUS\s+STARTED\s+LAST ACTIVITY\s+COST$/m);
    expect(out()).toMatch(new RegExp(`^${id}\\s+Hello\\s+assistant\\s+-\\s+input-required\\s+\\S+\\s+\\S+\\s+0\\.01 USD$`, "m"));
    expect(out()).toMatch(new RegExp(`^${inWorkspace.id}\\s+Hello\\s+workspace-assistant\\s+app\\s+working\\s`, "m"));
  });

  it("shortens a long, multi-line title to one line in the list and shows it whole in get", async () => {
    const { agentRuntime, tend } = platform();
    const text = `Why did the nightly run fail?\nAnd what should I change in the workflow so that it does not fail again next week?`;
    const { id } = await agentRuntime.startChat({ agent: "assistant", text });

    const listed = tend(["chat", "list"]);
    const got = tend(["chat", "get", id]);

    expect(await listed.exitCode).toBe(0);
    expect(listed.out()).toMatch(new RegExp(`^${id}\\s+Why did the nightly run fail\\? And what should I change in t…\\s+assistant\\s`, "m"));
    expect(await got.exitCode).toBe(0);
    expect(got.out()).toContain("Why did the nightly run fail? And what should I change in the workflow");
    expect(got.out()).toContain("what should I change in the workflow so that it does not fail again next week?");
  });

  it("shows the workspace of a chat with a workspace's assistant, and whether it may write", async () => {
    const { agentRuntime, tend } = platform();
    const { id } = await agentRuntime.startChat({ workspace: "app", text: "Hello" });

    const { exitCode, out } = tend(["chat", "get", id]);

    expect(await exitCode).toBe(0);
    expect(out()).toMatch(/^WORKSPACE\s+app \(read-only\)$/m);
  });

  it("prints the chat list and one chat as JSON or YAML", async () => {
    const { agentRuntime, tend } = platform();
    const id = await existingChat(agentRuntime, "Hi.");

    const listed = tend(["chat", "list", "-o", "json"]);
    const got = tend(["chat", "get", id, "-o", "yaml"]);

    expect(await listed.exitCode).toBe(0);
    expect(JSON.parse(listed.out())).toMatchObject({ items: [{ id, agent: "assistant", status: "input-required" }] });
    expect(await got.exitCode).toBe(0);
    expect(got.out()).toContain(`id: ${id}`);
    expect(got.out()).toContain("status: input-required");
  });

  it("shows one chat with its last message", async () => {
    const { agentRuntime, tend } = platform();
    const id = await existingChat(agentRuntime, "Hi, how can I help?");

    const { exitCode, out } = tend(["chat", "get", id]);

    expect(await exitCode).toBe(0);
    expect(out()).toMatch(new RegExp(`^CHAT\\s+${id}$`, "m"));
    expect(out()).toMatch(/^AGENT\s+assistant$/m);
    expect(out()).toMatch(/^MESSAGE\s+Hi, how can I help\?$/m);
  });

  it("ends a chat", async () => {
    const { agentRuntime, tend } = platform();
    const id = await existingChat(agentRuntime, "Hi.");

    const { exitCode, out } = tend(["chat", "end", id]);

    expect(await exitCode).toBe(0);
    expect(out()).toBe(`chat ${id} ended\n`);
    expect(agentRuntime.chats.get(id)?.status).toBe("ended");
  });

  it("names a chat it does not find", async () => {
    const { tend } = platform();

    const got = tend(["chat", "get", "missing"]);
    const ended = tend(["chat", "end", "missing"]);
    const attached = tend(["chat", "attach", "missing"]);

    expect([await got.exitCode, await ended.exitCode, await attached.exitCode]).toEqual([1, 1, 1]);
    for (const client of [got, ended, attached]) expect(client.err()).toContain("chat missing not found");
  });
});

describe("tend chat attach", () => {
  it("prints the history of a chat and continues it live", async () => {
    const { agentRuntime, tend } = platform(["Two runs are active."]);
    const id = await existingChat(agentRuntime, "Hi, I am the assistant.");

    const { exitCode, input, out } = tend(["chat", "attach", id]);
    await until(() => out().includes("Hi, I am the assistant.") && out().endsWith("> "));
    input.type("What is running?");
    await until(() => out().includes("Two runs are active."));
    input.close();

    expect(await exitCode).toBe(0);
    expect(out()).toMatch(/task\s+assistant: Hello/);
    expect(out()).toMatch(/agent\s+Hi, I am the assistant\./);
    expect(out()).toMatch(/agent\s+Two runs are active\./);
    expect(out()).toContain(`left chat ${id}; it stays open`);
  });

  it("waits for the answer to a piped line before leaving at the end of input", async () => {
    const { agentRuntime, tend } = platform(["Two runs are active."]);
    const id = await existingChat(agentRuntime, "Hi, I am the assistant.");

    const { exitCode, input, out } = tend(["chat", "attach", id]);
    input.type("What is running?");
    input.close();

    expect(await exitCode).toBe(0);
    expect(out()).toMatch(/agent\s+Two runs are active\.[\s\S]*left chat \S+; it stays open/);
    expect(agentRuntime.chats.get(id)?.status).toBe("input-required");
  });

  it("shows two attached clients the same output; a message from either continues the chat", async () => {
    const { agentRuntime, tend } = platform(["Answer to the first.", "Answer to the second."]);
    const id = await existingChat(agentRuntime, "Hi.");
    const first = tend(["chat", "attach", id]);
    const second = tend(["chat", "attach", id]);
    await until(() => first.out().endsWith("> ") && second.out().endsWith("> "));

    first.input.type("From the first client");
    await until(() => second.out().includes("Answer to the first.") && second.out().endsWith("> "));
    second.input.type("From the second client");
    await until(() => first.out().includes("Answer to the second.") && first.out().endsWith("> "));
    first.input.close();
    second.input.close();

    expect([await first.exitCode, await second.exitCode]).toEqual([0, 0]);
    expect(second.out()).toMatch(/human\s+From the first client/);
    expect(first.out()).toMatch(/human\s+From the second client/);
    expect(first.out()).not.toMatch(/human\s+From the first client/);
    for (const client of [first, second]) {
      expect(client.out()).toMatch(/agent\s+Answer to the first\.[\s\S]*agent\s+Answer to the second\./);
    }
  });

  it("ends attaching when another client ends the chat", async () => {
    const { agentRuntime, tend } = platform();
    const id = await existingChat(agentRuntime, "Hi.");
    const attached = tend(["chat", "attach", id]);
    await until(() => attached.out().endsWith("> "));

    await agentRuntime.endChat(id);

    expect(await attached.exitCode).toBe(0);
    expect(attached.out()).toContain(`chat ${id} has ended`);
  });

  it("prints the whole transcript of an ended chat", async () => {
    const { agentRuntime, tend } = platform();
    const id = await existingChat(agentRuntime, "Hi.");
    await agentRuntime.endChat(id);

    const { exitCode, out } = tend(["chat", "attach", id]);

    expect(await exitCode).toBe(0);
    expect(out()).toMatch(/agent\s+Hi\./);
    expect(out()).toContain(`chat ${id} has ended`);
  });
});
