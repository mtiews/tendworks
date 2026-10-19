import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { API_TOKEN, client } from "./support/control-plane.js";

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
      const volume = `tendworks-volume-${chatId}-session`;
      const whileOpen = await docker("ps", "-q", "--filter", `volume=${volume}`);
      const { data: ended } = await client.POST("/chats/{chatId}/end", { params: { path: { chatId } } });

      expect(answered).toMatchObject({ status: "input-required", message: "I remember: My name is Ada. | What is my name?", cost: { amount: 0.02, currency: "USD" } });
      expect(whileOpen).not.toBe("");
      expect(ended).toMatchObject({ status: "ended" });
      expect(await docker("ps", "-aq", "--filter", `volume=${volume}`)).toBe("");
      expect(await docker("volume", "ls", "-q", "--filter", `name=tendworks-volume-${chatId}`)).toBe("");
      const { data: transcript } = await client.GET("/chats/{chatId}/transcript", { params: { path: { chatId } } });
      expect(transcript?.items.filter((entry) => entry.type === "session-started")).toHaveLength(1);
      expect(transcript?.items.at(-1)).toMatchObject({ type: "task-ended", state: "TASK_STATE_COMPLETED" });
    },
  );
});
