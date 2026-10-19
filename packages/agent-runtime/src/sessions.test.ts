import { readFileSync } from "node:fs";
import type { A2A, AgentProfile } from "@tendworks/shared";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { createAgentRuntime } from "./index.js";

const profile = (name: string, spec: Partial<AgentProfile.AgentProfileSpec> = {}): AgentProfile.AgentProfile => ({
  apiVersion: "tendworks.dev/v1",
  kind: "AgentProfile",
  metadata: { name },
  spec: { harness: "fake", ...spec },
});

const contract = (file: string) => parse(readFileSync(new URL(`../../../contracts/${file}`, import.meta.url), "utf8")) as { $id: string };
const isSession = new Ajv2020({ strict: false, validateFormats: false })
  .addSchema(contract("schemas/agent-session.schema.yaml"))
  .getSchema("https://tendworks.dev/schemas/v1/schemas/agent-session.schema.yaml#/$defs/agentSession")!;

const say = (text: string): A2A.Message => ({ messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }] });
const stepRequest = (runId: string, stepReference: string): A2A.SendMessageRequest => ({
  message: { messageId: `${runId}${stepReference}`, role: "ROLE_USER", parts: [{ text: "Implement it" }] },
  metadata: { "dev.tendworks/runId": runId, "dev.tendworks/stepReference": stepReference },
});

/** A runtime whose fake agents wait until the test lets them finish. */
function setup() {
  const waiting: (() => void)[] = [];
  const runtime = createAgentRuntime({
    profiles: [profile("developer", { fake: { delaySeconds: 1 } }), profile("assistant", { fake: { message: "Hi", delaySeconds: 1 }, chat: {} })],
    sleep: () => new Promise<void>((resolve) => waiting.push(resolve)),
  });
  const finishAll = () => waiting.splice(0).forEach((resolve) => resolve());
  return { runtime, waiting, finishAll };
}

describe("active agent sessions", () => {
  it("lists the agent session of a working run step with its run and step", async () => {
    const { runtime, waiting, finishAll } = setup();
    const done = runtime.sendMessage("developer", stepRequest("run-1", "/do/0/implement"));
    await vi.waitFor(() => expect(waiting).toHaveLength(1));

    const sessions = await runtime.listSessions();

    expect(sessions).toEqual([
      { kind: "run-step", agent: "developer", taskId: expect.any(String), status: "working", startedAt: expect.any(String), run: "run-1", step: "/do/0/implement" },
    ]);
    expect(isSession(sessions[0]), JSON.stringify(isSession.errors)).toBe(true);
    finishAll();
    expect((await done).id).toBe(sessions[0]!.taskId);
  });

  it("lists the agent session of an open chat, working or waiting for the next message", async () => {
    const { runtime, waiting, finishAll } = setup();
    const chat = await runtime.startChat("assistant", say("Hello"));
    await vi.waitFor(() => expect(waiting).toHaveLength(1));

    const working = await runtime.listSessions();
    finishAll();
    await vi.waitFor(async () => expect((await runtime.getChat(chat.id))?.status).toBe("input-required"));
    const idle = await runtime.listSessions();

    expect(working).toEqual([{ kind: "chat", agent: "assistant", taskId: chat.id, status: "working", startedAt: chat.startedAt, chat: chat.id }]);
    expect(isSession(working[0]), JSON.stringify(isSession.errors)).toBe(true);
    expect(idle).toEqual([{ ...working[0], status: "input-required" }]);
  });

  it("leaves out finished run steps and ended chats", async () => {
    const { runtime, waiting, finishAll } = setup();
    const step = runtime.sendMessage("developer", stepRequest("run-1", "/do/0/implement"));
    const chat = await runtime.startChat("assistant", say("Hello"));
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    finishAll();
    await step;
    await runtime.endChat(chat.id);

    expect(await runtime.listSessions()).toEqual([]);
  });

  it("lists the most recently started session first", async () => {
    let clock = Date.parse("2026-10-19T10:00:00Z");
    const waiting: (() => void)[] = [];
    const runtime = createAgentRuntime({
      profiles: [profile("developer", { fake: { delaySeconds: 1 } }), profile("assistant", { fake: { delaySeconds: 1 }, chat: {} })],
      sleep: () => new Promise<void>((resolve) => waiting.push(resolve)),
      now: () => new Date((clock += 1_000)),
    });
    void runtime.sendMessage("developer", stepRequest("run-1", "/do/0/implement"));
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    await runtime.startChat("assistant", say("Hello"));

    expect((await runtime.listSessions()).map((session) => session.kind)).toEqual(["chat", "run-step"]);
    waiting.forEach((resolve) => resolve());
  });
});
