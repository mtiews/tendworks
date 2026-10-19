import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { client } from "./support/control-plane.js";

type Agent = ControlPlane.components["schemas"]["Agent"];

const sessionsOf = async (name: string): Promise<Agent["sessions"]> => {
  const { data, response } = await client.GET("/agents");
  if (!data) throw new Error(`GET /agents answered HTTP ${response.status}`);
  return data.items.find((agent) => agent.name === name)?.sessions ?? [];
};

/** Polls until `check` holds. */
async function eventually(check: () => Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !(await check()); ) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe("active agent sessions", () => {
  it("lists a working run step and an open chat under their profiles until they end", { timeout: 90_000 }, async () => {
    const { data: run } = await client.POST("/runs", { body: { workflow: "slow-agent" } });
    const { data: chat } = await client.POST("/chats", { body: { agent: "fake-assistant", text: "Hello" } });
    expect(run && chat).toBeTruthy();

    await eventually(async () => (await sessionsOf("fake-slow-developer")).some((session) => session.kind === "run-step" && session.run === run!.id), "the run step's session");
    const step = (await sessionsOf("fake-slow-developer")).find((session) => session.kind === "run-step" && session.run === run!.id);
    const chatting = (await sessionsOf("fake-assistant")).find((session) => session.kind === "chat" && session.chat === chat!.id);

    expect(step).toMatchObject({ kind: "run-step", agent: "fake-slow-developer", status: "working", step: "/do/0/implement" });
    expect(chatting).toMatchObject({ kind: "chat", agent: "fake-assistant", taskId: chat!.id });

    await client.POST("/chats/{chatId}/end", { params: { path: { chatId: chat!.id } } });
    expect((await sessionsOf("fake-assistant")).some((session) => session.kind === "chat" && session.chat === chat!.id)).toBe(false);
    await eventually(async () => !(await sessionsOf("fake-slow-developer")).some((session) => session.kind === "run-step" && session.run === run!.id), "the run step to finish");
  });
});
