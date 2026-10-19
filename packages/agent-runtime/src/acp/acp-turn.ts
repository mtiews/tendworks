import * as acp from "@agentclientprotocol/sdk";
import type { Cost, HarnessObserver } from "../harness.js";
import type { SandboxProcess } from "../sandboxes.js";

export interface AcpTurnOptions {
  /** The harness process speaking ACP over its stdin and stdout. */
  process: SandboxProcess;
  /** Absolute working directory of the session, inside the sandbox. */
  cwd: string;
  prompt: acp.ContentBlock[];
  observer: HarnessObserver;
  /** Interval of keep-alive requests while the session runs. */
  keepAliveMs: number;
  /** How long the turn may take before it is cancelled. */
  timeoutMs: number;
  /** How long a cancelled turn gets to end. */
  cancelGraceMs?: number;
  /** Removes secrets from text the harness wrote before it is recorded or reported. */
  redact?: (text: string) => string;
}

export type AcpTurn =
  | { outcome: "stopped"; sessionId: string; stopReason: acp.StopReason; reply: string; cost?: Cost }
  | { outcome: "error"; error: string };

/** Extension method no agent implements; any answer, including "method not found", is traffic. */
const KEEP_ALIVE = "_tendworks/keepalive";

class HarnessClosed extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Drives one prompt turn over ACP: initialize, `session/new`, `session/prompt`, recording
 * every `session/update` and allowing tool permissions once (the sandbox is the
 * boundary). The text the agent wrote after its last tool call is the reply; the last
 * `usage_update` cost is the session's cost. While the turn runs, keep-alive requests
 * make sure a quiet session still carries traffic, so idle connections are not cut.
 */
export async function runAcpTurn(options: AcpTurnOptions): Promise<AcpTurn> {
  const { process, cwd, prompt, observer, keepAliveMs, timeoutMs, cancelGraceMs = 10_000, redact = (text) => text } = options;
  const stderr = collect(process.stderr, (line) => observer.record({ type: "harness-stderr", text: redact(line) }));

  let reply = "";
  let cost: Cost | undefined;
  const connection = acp
    .client({ name: "tendworks-agent-runtime" })
    .onNotification(acp.methods.client.session.update, ({ params: { update } }) => {
      observer.record({ type: "acp-update", update });
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          if (update.content.type === "text") {
            reply += update.content.text;
            observer.progress(reply.trim().slice(-500));
          }
          break;
        case "tool_call":
          reply = "";
          observer.progress(`using a tool: ${update.title}`);
          break;
        case "usage_update":
          if (update.cost) cost = { amount: update.cost.amount, currency: update.cost.currency };
          break;
      }
    })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      const option = params.options.find((o) => o.kind === "allow_once") ?? params.options.find((o) => o.kind === "allow_always");
      observer.record({ type: "permission", toolCall: params.toolCall.title ?? params.toolCall.toolCallId, optionId: option?.optionId ?? null });
      return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
    })
    .connect(acp.ndJsonStream(process.stdin, process.stdout));
  const agent = connection.agent;
  const closed = connection.closed.then(() => {
    throw new HarnessClosed();
  });
  closed.catch(() => {});

  let keepAlive: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    const init = await Promise.race([
      agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
      closed,
    ]);
    observer.record({ type: "acp-initialize", protocolVersion: init.protocolVersion, agentInfo: init.agentInfo ?? null });
    const { sessionId } = await Promise.race([agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] }), closed]);
    observer.record({ type: "acp-session", sessionId });

    keepAlive = setInterval(() => void agent.request(KEEP_ALIVE, {}).catch(() => {}), keepAliveMs);
    const turn = agent.request(acp.methods.agent.session.prompt, { sessionId, prompt });
    turn.catch(() => {});
    const timedOut = new Promise<"timed-out">((resolve) => (timeout = setTimeout(() => resolve("timed-out"), timeoutMs)));
    const ended = await Promise.race([turn, closed, timedOut]);
    if (ended === "timed-out") {
      await agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {});
      await Promise.race([turn.catch(() => {}), closed.catch(() => {}), sleep(cancelGraceMs)]);
      return { outcome: "error", error: `the agent session timed out after ${Math.round(timeoutMs / 1000)} s and was cancelled` };
    }
    observer.record({ type: "acp-stop", stopReason: ended.stopReason });
    return { outcome: "stopped", sessionId, stopReason: ended.stopReason, reply: reply.trim(), ...(cost ? { cost } : {}) };
  } catch (error) {
    // The harness ended or broke the protocol; its error output says why.
    const exitCode = await Promise.race([process.exited.catch(() => undefined), sleep(1_000).then(() => undefined)]);
    await Promise.race([stderr.done, sleep(1_000)]);
    const reason = error instanceof HarnessClosed ? "the harness ended unexpectedly" : `the harness failed: ${error instanceof Error ? error.message : String(error)}`;
    const code = exitCode === undefined ? "" : ` (exit code ${exitCode})`;
    const output = stderr.tail();
    return { outcome: "error", error: redact(`${reason}${code}${output ? `: ${output}` : ""}`) };
  } finally {
    clearInterval(keepAlive);
    clearTimeout(timeout);
    // End the adapter cleanly: closing its input lets it dispose its session.
    connection.close();
    await process.stdin.close().catch(() => {});
    await Promise.race([process.exited.catch(() => {}), sleep(5_000)]);
  }
}

/** Reads a stream line by line, keeping the last lines for error messages. */
function collect(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const lines: string[] = [];
  let partial = "";
  const add = (line: string) => {
    if (line.trim() === "") return;
    lines.push(line);
    if (lines.length > 20) lines.shift();
    onLine(line);
  };
  const done = (async () => {
    try {
      for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
        const parts = (partial + chunk).split("\n");
        partial = parts.pop() ?? "";
        parts.forEach(add);
      }
    } catch {
      // the stream broke with the connection; what was read is kept
    }
    add(partial);
    partial = "";
  })();
  return { done, tail: () => [...lines, partial].filter((line) => line.trim() !== "").slice(-5).join("\n").slice(-1_000) };
}
