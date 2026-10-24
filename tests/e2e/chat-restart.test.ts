import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { baseUrl, client, READ_TOKEN } from "./support/control-plane.js";
import { volumeOf } from "./support/installation.js";

type Chat = ControlPlane.components["schemas"]["chat"];
type Entry = ControlPlane.components["schemas"]["transcriptEntry"];

const composeFile = fileURLToPath(new URL("../../deploy/compose.yaml", import.meta.url));
const compose = (...args: string[]) => promisify(execFile)("docker", ["compose", "-f", composeFile, ...args], { timeout: 120_000 });
const docker = async (...args: string[]) => (await promisify(execFile)("docker", args, { timeout: 60_000 })).stdout.trim();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getChat = async (chatId: string): Promise<Chat> => {
  const { data, response } = await client.GET("/chats/{chatId}", { params: { path: { chatId } } });
  if (!data) throw new Error(`GET /chats/${chatId} answered HTTP ${response.status}`);
  return data;
};

/** Waits until the chat's turn ended. */
async function waiting(chatId: string, timeoutMs: number): Promise<Chat> {
  for (const deadline = Date.now() + timeoutMs; ; await pause(500)) {
    const chat = await getChat(chatId).catch(() => undefined);
    if (chat && chat.status !== "working") return chat;
    if (Date.now() > deadline) throw new Error(`chat ${chatId} still works on its turn`);
  }
}

async function say(chatId: string, text: string): Promise<void> {
  const { response } = await client.POST("/chats/{chatId}/messages", { params: { path: { chatId } }, body: { text } });
  expect(response.status).toBe(200);
}

const transcript = async (chatId: string): Promise<Entry[]> =>
  (await client.GET("/chats/{chatId}/transcript", { params: { path: { chatId } } })).data?.items ?? [];

/**
 * Follows a chat's transcript as a client does: entries arrive in `entries`; when the
 * connection is cut (e.g. by a restart) it reconnects with Last-Event-ID, until `until`.
 */
function follow(chatId: string, until: (entry: Entry) => boolean) {
  const entries: Entry[] = [];
  const done = (async () => {
    for (const deadline = Date.now() + 300_000; Date.now() < deadline; await pause(1_000)) {
      const lastEventId = entries.at(-1)?.position;
      const response = await fetch(`${baseUrl}/chats/${chatId}/transcript/stream`, {
        headers: { authorization: `Bearer ${READ_TOKEN}`, ...(lastEventId === undefined ? {} : { "last-event-id": String(lastEventId) }) },
      }).catch(() => undefined);
      if (!response?.ok || !response.body) continue;
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      try {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          buffer += chunk.value;
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop()!;
          for (const block of blocks) {
            const data = block.split("\n").find((line) => line.startsWith("data: "));
            if (!block.includes("event: entry") || !data) continue;
            const entry = JSON.parse(data.slice(6)) as Entry;
            entries.push(entry);
            if (until(entry)) return;
          }
        }
      } catch {
        // cut by the restart; reconnect below
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    throw new Error(`following chat ${chatId} never saw the end it waited for`);
  })();
  return { entries, done };
}

/** The harness needs some credential selected; the stack gets it from the environment or deploy/.env. */
function credentialSelected(): boolean {
  if (process.env.TEND_CLAUDE_CODE_CREDENTIAL) return true;
  const env = fileURLToPath(new URL("../../deploy/.env", import.meta.url));
  return existsSync(env) && /^TEND_CLAUDE_CODE_CREDENTIAL=(oauth-token|api-key)\s*$/m.test(readFileSync(env, "utf8"));
}

// A chat on the real path (sandbox through the socket proxy, volumes, ACP session/resume)
// with the scripted ACP agent (images/sandbox-scripted-acp) and profile scripted-assistant,
// whose idle time is one minute. A prompt without "chat:" is a long turn that writes
// before.txt, works, then writes after.txt and lists the files.
describe.skipIf(!credentialSelected())("a chat across a platform restart and an idle sandbox", () => {
  it("continues a turn the restart interrupted, then resumes after the idle time with its conversation and workspace", { timeout: 600_000 }, async () => {
    const { data: started, response } = await client.POST("/chats", { body: { agent: "scripted-assistant", text: "Write the files" } });
    expect(response.status).toBe(201);
    const chatId = started!.id;
    const volume = volumeOf(`${chatId}-session`);
    const followed = follow(chatId, (entry) => entry.type === "input-required");
    for (const deadline = Date.now() + 120_000; !(await transcript(chatId)).some((entry) => entry.type === "tool-call"); await pause(500)) {
      if (Date.now() > deadline) throw new Error(`chat ${chatId} never started its turn`);
    }

    await compose("restart", "server", "worker");
    await compose("up", "-d", "--wait", "server", "worker");
    await followed.done;
    const resumed = await waiting(chatId, 240_000);

    expect(resumed).toMatchObject({ status: "input-required", message: expect.stringMatching(/^resumed session scripted-[0-9a-f-]+\nafter\.txt\nbefore\.txt$/) });
    expect(followed.entries.map((entry) => entry.position)).toEqual(followed.entries.map((_, index) => index));
    expect(followed.entries.map((entry) => entry.type)).toEqual(expect.arrayContaining(["session-started", "task-resumed", "session-resumed"]));

    await say(chatId, "chat: Remember me.");
    expect(await waiting(chatId, 60_000)).toMatchObject({ message: "I remember: Remember me." });
    for (const deadline = Date.now() + 180_000; (await docker("ps", "-aq", "--filter", `volume=${volume}`)) !== ""; await pause(2_000)) {
      if (Date.now() > deadline) throw new Error(`the sandbox of idle chat ${chatId} is still there`);
    }
    const volumesWhileIdle = await docker("volume", "ls", "-q", "--filter", `name=${volumeOf(chatId)}`);

    await say(chatId, "chat: Still there?");
    const answered = await waiting(chatId, 120_000);
    await say(chatId, "List the files");
    const listed = await waiting(chatId, 120_000);
    await client.POST("/chats/{chatId}/end", { params: { path: { chatId } } });

    expect(volumesWhileIdle.split("\n").sort()).toEqual([volumeOf(`${chatId}-session`), volumeOf(`${chatId}-workspace`)]);
    expect(answered).toMatchObject({ status: "input-required", message: "I remember: Remember me. | Still there?" });
    expect(listed.message).toMatch(/^resumed session scripted-[0-9a-f-]+\nafter\.txt\nbefore\.txt$/);
    // One agent session throughout: every new sandbox resumed it. How often depends on how
    // often the worker started (compose may recreate it on `up`), so only the resume of the
    // turn after the idle time is counted.
    const entries = await transcript(chatId);
    const [session, ...more] = entries.filter((entry) => entry.type === "session-started");
    expect(more).toEqual([]);
    expect(entries.filter((entry) => entry.type === "session-resume-failed")).toEqual([]);
    const resumes = entries.filter((entry) => entry.type === "session-resumed");
    expect(resumes.map((entry) => (entry as { sessionId: string }).sessionId)).toEqual(resumes.map(() => (session as { sessionId: string }).sessionId));
    const afterIdle = entries.findIndex((entry) => entry.type === "message-received" && JSON.stringify(entry).includes("Still there?"));
    const answeredAfterIdle = entries.findIndex((entry, index) => index > afterIdle && entry.type === "input-required");
    expect(afterIdle).toBeGreaterThan(0);
    expect(entries.slice(afterIdle, answeredAfterIdle).map((entry) => entry.type)).toContain("session-resumed");
  });
});
