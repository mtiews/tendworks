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
//
// A prompt "mcp:<tool>" calls that tool without arguments on the first HTTP MCP server the
// session was given (the platform MCP server) and answers with what it returned, or with
// why the call failed: "mcp <tool>: <text>" or "mcp <tool> failed: <reason>".
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const configDir = process.env.CLAUDE_CONFIG_DIR ?? "/tmp/scripted-acp";
const turnMs = Number(process.env.SCRIPTED_TURN_SECONDS ?? "90") * 1000;
const sessionFile = (sessionId) => join(configDir, "projects", `${sessionId}.jsonl`);
const sessions = new Map(); // sessionId -> { cwd, resumed, mcpServers }
let cancel = () => {};
// Cumulative for the session, as ACP defines it; this process knows only its own turns.
let cost = 0;

const update = (ctx, sessionUpdate) => ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update: sessionUpdate });

const connection = acp
  .agent({ name: "scripted-acp-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { sessionCapabilities: { resume: {} }, mcpCapabilities: { http: true } },
  }))
  .onRequest(acp.methods.agent.session.new, (ctx) => {
    const sessionId = `scripted-${crypto.randomUUID()}`;
    mkdirSync(join(configDir, "projects"), { recursive: true });
    writeFileSync(sessionFile(sessionId), `${JSON.stringify({ cwd: ctx.params.cwd })}\n`);
    sessions.set(sessionId, { cwd: ctx.params.cwd, resumed: false, mcpServers: ctx.params.mcpServers ?? [] });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.resume, (ctx) => {
    if (!existsSync(sessionFile(ctx.params.sessionId))) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    sessions.set(ctx.params.sessionId, { cwd: ctx.params.cwd, resumed: true, mcpServers: ctx.params.mcpServers ?? [] });
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    const said = ctx.params.prompt.map((block) => (block.type === "text" ? block.text : "")).join(" ");
    if (said.startsWith("mcp:")) {
      const tool = said.slice(4).trim();
      const text = await callTool(session.mcpServers, tool).then(
        (result) => `mcp ${tool}: ${result}`,
        (error) => `mcp ${tool} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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

/** Calls a tool on the first HTTP MCP server with one JSON-RPC request (the platform's server is stateless). */
async function callTool(mcpServers, tool) {
  const server = mcpServers.find((candidate) => candidate.type === "http");
  if (!server) throw new Error("no HTTP MCP server configured for this session");
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: {} } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { result, error } = await response.json();
  if (error) throw new Error(error.message);
  return result.content.map((part) => part.text ?? "").join("");
}

await connection.closed;
