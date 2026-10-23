import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { API_TOKEN, client } from "./support/control-plane.js";
import { volumeOf } from "./support/installation.js";

type Chat = ControlPlane.components["schemas"]["chat"];

const composeFile = fileURLToPath(new URL("../../deploy/compose.yaml", import.meta.url));
const docker = async (...args: string[]) => (await promisify(execFile)("docker", args, { timeout: 60_000 })).stdout.trim();

const getChat = async (chatId: string): Promise<Chat> => {
  const { data, response } = await client.GET("/chats/{chatId}", { params: { path: { chatId } } });
  if (!data) throw new Error(`GET /chats/${chatId} answered HTTP ${response.status}`);
  return data;
};

/** Waits until the chat's turn ended. */
async function waiting(chatId: string, timeoutMs = 60_000): Promise<Chat> {
  for (const deadline = Date.now() + timeoutMs; ; ) {
    const chat = await getChat(chatId);
    if (chat.status !== "working") return chat;
    if (Date.now() > deadline) throw new Error(`chat ${chatId} still works on its turn`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** `tend` run in the server container, with its output collected and its input open until `close`. */
function tendClient(...args: string[]) {
  const tend = spawn("docker", ["compose", "-f", composeFile, "exec", "-T", "server", "node", "apps/cli/dist/main.js", "--url", "http://localhost:8080", "--token", API_TOKEN, ...args]);
  let stdout = "";
  let stderr = "";
  tend.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  tend.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => tend.on("close", resolve));
  return {
    exited,
    stdout: () => stdout,
    stderr: () => stderr,
    write: (line: string) => tend.stdin.write(`${line}\n`),
    close: () => tend.stdin.end(),
    async until(text: string) {
      for (const deadline = Date.now() + 30_000; !stdout.includes(text); ) {
        if (Date.now() > deadline) throw new Error(`tend ${args.join(" ")} never printed ${JSON.stringify(text)}: ${stdout}${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
}

/** The harness needs some credential selected; the stack gets it from the environment or deploy/.env. */
function credentialSelected(): boolean {
  if (process.env.TEND_CLAUDE_CODE_CREDENTIAL) return true;
  const env = fileURLToPath(new URL("../../deploy/.env", import.meta.url));
  return existsSync(env) && /^TEND_CLAUDE_CODE_CREDENTIAL=(oauth-token|api-key)\s*$/m.test(readFileSync(env, "utf8"));
}

describe("chats", () => {
  it("tend chat streams the agent's answer and ends the chat; its transcript stays readable", { timeout: 60_000 }, async () => {
    const tend = spawn("docker", ["compose", "-f", composeFile, "exec", "-T", "server", "node", "apps/cli/dist/main.js", "--url", "http://localhost:8080", "--token", API_TOKEN, "chat", "fake-assistant"]);
    let stdout = "";
    let stderr = "";
    tend.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    tend.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => tend.on("close", resolve));
    const until = async (text: string) => {
      for (const deadline = Date.now() + 30_000; !stdout.includes(text); ) {
        if (Date.now() > deadline) throw new Error(`tend chat never printed ${JSON.stringify(text)}: ${stdout}${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };

    tend.stdin.write("Hello\n");
    await until("Pretended to answer.");
    tend.stdin.write("/end\n");
    tend.stdin.end();

    expect(await exited, stderr).toBe(0);
    const chatId = /chat (\S+) with fake-assistant/.exec(stdout)?.[1];
    expect(chatId).toBeDefined();
    expect(stdout).toContain(`chat ${chatId} ended`);
    expect(await getChat(chatId!)).toMatchObject({ status: "ended", agent: "fake-assistant" });
    const { data: transcript } = await client.GET("/chats/{chatId}/transcript", { params: { path: { chatId: chatId! } } });
    expect(transcript?.items.map((entry) => entry.type)).toEqual(["task-started", "message-chunk", "turn-ended", "input-required", "task-ended"]);
  });

  it("lets a second client attach with the history; both see the same output and either continues the chat", { timeout: 60_000 }, async () => {
    const { data: started } = await client.POST("/chats", { body: { agent: "fake-assistant", text: "Hello" } });
    const chatId = started!.id;
    await waiting(chatId);

    const first = tendClient("chat", "attach", chatId);
    const second = tendClient("chat", "attach", chatId);
    await first.until("Pretended to answer.");
    await second.until("Pretended to answer.");
    first.write("From the first client");
    await second.until("From the first client");
    await waiting(chatId);
    second.write("From the second client");
    await first.until("From the second client");
    await waiting(chatId);
    second.write("/end");
    first.close();
    second.close();

    expect(await second.exited, second.stderr()).toBe(0);
    expect(await first.exited, first.stderr()).toBe(0);
    expect(await getChat(chatId)).toMatchObject({ status: "ended" });
    for (const tend of [first, second]) expect(tend.stdout().match(/Pretended to answer\./g)).toHaveLength(3);
    expect(first.stdout()).toMatch(/human\s+From the second client/);
    expect(second.stdout()).toMatch(/human\s+From the first client/);
  });

  it("lists chats and shows one as YAML", async () => {
    const { data: started } = await client.POST("/chats", { body: { agent: "fake-assistant", text: "Hello" } });
    const chatId = started!.id;
    await waiting(chatId);

    const listed = tendClient("chat", "list");
    const got = tendClient("chat", "get", chatId, "-o", "yaml");

    expect(await listed.exited, listed.stderr()).toBe(0);
    expect(listed.stdout()).toMatch(new RegExp(`^${chatId}\\s+fake-assistant\\s+input-required`, "m"));
    expect(await got.exited, got.stderr()).toBe(0);
    expect(got.stdout()).toContain(`id: ${chatId}`);
    await client.POST("/chats/{chatId}/end", { params: { path: { chatId } } });
  });

  it("refuses a chat with a profile that does not allow chats", async () => {
    const { response, error } = await client.POST("/chats", { body: { agent: "fake-developer", text: "Hello" } });

    expect(response.status).toBe(400);
    expect(error?.detail).toContain("spec.chat");
  });

  // The Claude Code harness on the real path with the scripted ACP agent (images/sandbox-scripted-acp).
  it.skipIf(!credentialSelected())(
    "holds several turns in one agent session in a sandbox, and leaves no sandbox or volume when it ends",
    { timeout: 180_000 },
    async () => {
      const { data: started, response } = await client.POST("/chats", { body: { agent: "scripted-assistant", text: "chat: My name is Ada." } });
      expect(response.status).toBe(201);
      const chatId = started!.id;
      expect(await waiting(chatId, 120_000)).toMatchObject({ status: "input-required", message: "I remember: My name is Ada." });

      const sent = await client.POST("/chats/{chatId}/messages", { params: { path: { chatId } }, body: { text: "chat: What is my name?" } });
      expect(sent.response.status).toBe(200);
      const answered = await waiting(chatId);
      const volume = volumeOf(`${chatId}-session`);
      const whileOpen = await docker("ps", "-q", "--filter", `volume=${volume}`);
      const { data: ended } = await client.POST("/chats/{chatId}/end", { params: { path: { chatId } } });

      expect(answered).toMatchObject({ status: "input-required", message: "I remember: My name is Ada. | What is my name?", cost: { amount: 0.02, currency: "USD" } });
      expect(whileOpen).not.toBe("");
      expect(ended).toMatchObject({ status: "ended" });
      expect(await docker("ps", "-aq", "--filter", `volume=${volume}`)).toBe("");
      expect(await docker("volume", "ls", "-q", "--filter", `name=${volumeOf(chatId)}`)).toBe("");
      const { data: transcript } = await client.GET("/chats/{chatId}/transcript", { params: { path: { chatId } } });
      expect(transcript?.items.filter((entry) => entry.type === "session-started")).toHaveLength(1);
      expect(transcript?.items.at(-1)).toMatchObject({ type: "task-ended", state: "TASK_STATE_COMPLETED" });
    },
  );

  it.skipIf(!credentialSelected())(
    "lets the agent of a profile that lists the platform MCP server call one of its tools through the gateway",
    { timeout: 180_000 },
    async () => {
      // "mcp:<tool>" makes the scripted agent call that tool on the MCP server its session was given.
      const { data: started, response } = await client.POST("/chats", { body: { agent: "scripted-mcp-assistant", text: "mcp:list_agents" } });
      expect(response.status).toBe(201);
      const chatId = started!.id;
      const answered = await waiting(chatId, 120_000);
      await client.POST("/chats/{chatId}/end", { params: { path: { chatId } } });

      expect(answered.status).toBe("input-required");
      expect(answered.message).toMatch(/^mcp list_agents: /);
      const listed = JSON.parse(answered.message!.replace(/^mcp list_agents: /, "")) as { items: { name: string }[] };
      expect(listed.items.map((agent) => agent.name)).toContain("scripted-mcp-assistant");
    },
  );

  it.skipIf(!credentialSelected())("cancels a long turn in the sandbox; the chat stays open in the same session", { timeout: 180_000 }, async () => {
    // A prompt without "chat:" makes the scripted agent work for a long time.
    const { data: started } = await client.POST("/chats", { body: { agent: "scripted-assistant", text: "Work for a long time." } });
    const chatId = started!.id;
    const of = { params: { path: { chatId } } };
    for (const deadline = Date.now() + 120_000; ; ) {
      const { data } = await client.GET("/chats/{chatId}/transcript", of);
      if (data?.items.some((entry) => entry.type === "tool-call")) break;
      if (Date.now() > deadline) throw new Error("the agent never started working");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const cancelled = await client.POST("/chats/{chatId}/cancel", of);
    const sent = await client.POST("/chats/{chatId}/messages", { ...of, body: { text: "chat: Something quick instead." } });
    const answered = await waiting(chatId);
    await client.POST("/chats/{chatId}/end", of);

    expect(cancelled.data).toMatchObject({ status: "input-required" });
    expect(sent.response.status).toBe(200);
    expect(answered).toMatchObject({ status: "input-required", message: "I remember: Something quick instead." });
    const { data: transcript } = await client.GET("/chats/{chatId}/transcript", of);
    expect(transcript?.items.filter((entry) => entry.type === "turn-ended")).toMatchObject([{ reason: "cancelled" }, { reason: "completed" }]);
    expect(transcript?.items.filter((entry) => entry.type === "session-started")).toHaveLength(1);
  });
});
