#!/usr/bin/env node
// A scripted ACP agent standing in for the Claude Code adapter (`claude-agent-acp`) in the
// end-to-end restart test. Like Claude Code it keeps each session as a file in its config
// directory ($CLAUDE_CONFIG_DIR, on the session volume) and can resume a session only
// while that file exists.
//
// A new session's turn writes before.txt into the working directory and then works for
// SCRIPTED_TURN_SECONDS (default 90), long enough to restart the platform; a turn that
// gets to the end writes after.txt. The reply lists the .txt files and says whether the
// session was resumed. No model, no network, no credentials.
//
// A prompt that starts with "chat:" is a chat turn instead (end-to-end chat tests): it
// answers at once with every chat prompt of the session so far ("I remember: a | b"),
// kept in the session file, so it shows that a chat holds one agent session across turns.
// A prompt that starts with "secret:" answers with the SHA-256 digest of SCRIPTED_SECRET,
// so the end-to-end tests see an agent secret arrive without the value in a transcript.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const configDir = process.env.CLAUDE_CONFIG_DIR ?? "/tmp/scripted-acp";
const turnMs = Number(process.env.SCRIPTED_TURN_SECONDS ?? "90") * 1000;
const sessionFile = (sessionId) => join(configDir, "projects", `${sessionId}.jsonl`);
const sessions = new Map(); // sessionId -> { cwd, resumed }
let cancel = () => {};
// Cumulative for the session, as ACP defines it; this process knows only its own turns.
let cost = 0;

const update = (ctx, sessionUpdate) => ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update: sessionUpdate });

const connection = acp
  .agent({ name: "scripted-acp-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { sessionCapabilities: { resume: {} } },
  }))
  .onRequest(acp.methods.agent.session.new, (ctx) => {
    const sessionId = `scripted-${crypto.randomUUID()}`;
    mkdirSync(join(configDir, "projects"), { recursive: true });
    writeFileSync(sessionFile(sessionId), `${JSON.stringify({ cwd: ctx.params.cwd })}\n`);
    sessions.set(sessionId, { cwd: ctx.params.cwd, resumed: false });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.resume, (ctx) => {
    if (!existsSync(sessionFile(ctx.params.sessionId))) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    sessions.set(ctx.params.sessionId, { cwd: ctx.params.cwd, resumed: true });
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    const said = ctx.params.prompt.map((block) => (block.type === "text" ? block.text : "")).join(" ");
    if (said.startsWith("secret:")) {
      // The SHA-256 digest of SCRIPTED_SECRET (an agent secret a profile passes in), never the value.
      const value = process.env.SCRIPTED_SECRET;
      const text = value ? `secret digest ${createHash("sha256").update(value).digest("hex")}` : "no secret";
      await update(ctx, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      return { stopReason: "end_turn" };
    }
    if (said.startsWith("chat:")) {
      appendFileSync(sessionFile(ctx.params.sessionId), `${JSON.stringify({ prompt: said.slice(5).trim() })}\n`);
      const prompts = readFileSync(sessionFile(ctx.params.sessionId), "utf8")
        .split("\n")
        .filter((line) => line.includes('"prompt"'))
        .map((line) => JSON.parse(line).prompt);
      await update(ctx, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `I remember: ${prompts.join(" | ")}` } });
      cost += 0.01;
      await update(ctx, { sessionUpdate: "usage_update", used: 1000, size: 200000, cost: { amount: cost, currency: "USD" } });
      return { stopReason: "end_turn" };
    }
    const cancelled = new Promise((resolve) => (cancel = () => resolve("cancelled")));
    if (!session.resumed) {
      await update(ctx, { sessionUpdate: "tool_call", toolCallId: "write-before", title: "Write before.txt", status: "completed" });
      writeFileSync(join(session.cwd, "before.txt"), "before\n");
      const ended = await Promise.race([cancelled, new Promise((resolve) => setTimeout(() => resolve("worked"), turnMs))]);
      if (ended === "cancelled") return { stopReason: "cancelled" };
    }
    await update(ctx, { sessionUpdate: "tool_call", toolCallId: "write-after", title: "Write after.txt", status: "completed" });
    writeFileSync(join(session.cwd, "after.txt"), "after\n");
    const files = readdirSync(session.cwd).filter((name) => name.endsWith(".txt")).sort();
    const text = `${session.resumed ? "resumed" : "new"} session ${ctx.params.sessionId}\n${files.join("\n")}`;
    await update(ctx, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    cost += 0.01;
    await update(ctx, { sessionUpdate: "usage_update", used: 1000, size: 200000, cost: { amount: cost, currency: "USD" } });
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, () => cancel())
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));

await connection.closed;
