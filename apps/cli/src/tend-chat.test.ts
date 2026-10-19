import { createControlPlaneApi, createInMemoryAgentRuntime, createInMemoryRuns } from "@tendworks/control-plane";
import { describe, expect, it } from "vitest";
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

/** `tend chat` against the control plane with a fake agent runtime whose agent answers each message in turn. */
function chat(args: string[], answers: string[]) {
  const agentRuntime = createInMemoryAgentRuntime({ chatAgents: ["assistant"] });
  const api = createControlPlaneApi({
    agentRuntime,
    probes: [],
    configuration: { workflowNames: [], workflow: () => undefined, agentProfiles: [], triggerBindings: [], policies: [], pullRequestIntegrations: [] },
    apiToken: "test-token",
    runs: createInMemoryRuns(),
  });
  const input = keyboard();
  let stdout = "";
  let stderr = "";
  const exitCode = runTend(["--token", "test-token", "chat", ...args], {
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      const response = await api.fetch(request);
      if (request.method === "POST" && response.status < 300 && (pathname === "/chats" || pathname.endsWith("/messages"))) {
        const { id } = (await response.clone().json()) as { id: string };
        // The agent answers a moment later, while the client follows the transcript.
        setTimeout(() => agentRuntime.finishTurn(id, answers.shift() ?? "…", { amount: 0.01, currency: "USD" }), 5);
      }
      return response;
    },
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    lines: input.lines,
  });
  return { exitCode, input, agentRuntime, out: () => stdout, err: () => stderr };
}

const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(condition()).toBe(true);
};

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

  it("starts a chat with a repository as its workspace with --repo", async () => {
    const { exitCode, input, agentRuntime, out } = chat(["assistant", "--repo", "https://git.example/acme/app.git"], ["It has a README."]);

    await until(() => out().includes("> "));
    input.type("What is in the repository?");
    await until(() => out().includes("It has a README."));
    input.close();

    expect(await exitCode).toBe(0);
    const [started] = agentRuntime.chats.values();
    expect(started?.repository).toBe("https://git.example/acme/app.git");
    expect(out()).toMatch(/chat \S+ with assistant in a checkout of https:\/\/git\.example\/acme\/app\.git/);
  });

  it("refuses an invalid repository with the reason", async () => {
    const { exitCode, input, agentRuntime, err, out } = chat(["assistant", "--repo", "git.example:acme/app"], []);

    await until(() => out().includes("> "));
    input.type("Hello");

    expect(await exitCode).toBe(1);
    expect(err()).toMatch(/tend: repository "git\.example:acme\/app" is no https or http clone URL/);
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
