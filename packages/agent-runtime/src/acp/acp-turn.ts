import * as acp from "@agentclientprotocol/sdk";
import type { Cost, HarnessObserver } from "../harness.js";
import type { SandboxProcess } from "../sandboxes.js";
import { transcriptEntries, turnEnded } from "./transcript-entries.js";

export interface AcpSessionOptions {
  /** The harness process speaking ACP over its stdin and stdout. */
  process: SandboxProcess;
  /** Absolute working directory of the session, inside the sandbox. */
  cwd: string;
  observer: HarnessObserver;
  /** Interval of keep-alive requests while the session is open, between turns too. */
  keepAliveMs: number;
  /** How long a cancelled turn gets to end. */
  cancelGraceMs?: number;
  /** Agent-specific `_meta` of `session/new` and `session/resume`, e.g. extra instructions for the session. */
  sessionMeta?: Record<string, unknown>;
  /** Removes secrets from text the harness wrote before it is recorded or reported. */
  redact?: (text: string) => string;
  /** Called with the session id before the first prompt is sent, e.g. to keep it for a later resume. */
  onSession?: (sessionId: string) => Promise<void>;
  /** An earlier session to resume with `session/resume`; when the agent cannot resume it, a new session starts. */
  resume?: { sessionId: string };
}

export interface AcpTurnOptions extends Omit<AcpSessionOptions, "resume"> {
  prompt: acp.ContentBlock[];
  /** How long the turn may take before it is cancelled. */
  timeoutMs: number;
  /**
   * An earlier session to resume with `session/resume`, and what to prompt it with then.
   * When the agent cannot resume it, a new session gets `prompt` instead.
   */
  resume?: { sessionId: string; prompt: acp.ContentBlock[] };
}

export type AcpFailure = { outcome: "error"; error: string };

export type AcpTurn =
  | { outcome: "stopped"; sessionId: string; stopReason: acp.StopReason; reply: string; cost?: Cost }
  | AcpFailure;

/** An ACP session open on one harness process, for any number of prompt turns. */
export interface AcpSession {
  readonly sessionId: string;
  /** Whether an earlier session was resumed rather than a new one started. */
  readonly resumed: boolean;
  /** Whether the harness process still speaks; a session whose harness ended takes no further turn. */
  readonly open: boolean;
  /**
   * One prompt turn. The text the agent wrote after its last tool call is the reply; the
   * cost is what this turn added to the session's cumulative cost.
   */
  prompt(prompt: acp.ContentBlock[], options: { timeoutMs: number }): Promise<AcpTurn>;
  /** Ends the harness process cleanly. */
  close(): Promise<void>;
}

/** Extension method no agent implements; any answer, including "method not found", is traffic. */
const KEEP_ALIVE = "_tendworks/keepalive";

class HarnessClosed extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Amounts in a currency's smallest sensible unit, so differences of sums stay exact enough to show. */
const round = (amount: number) => Math.round(amount * 1e6) / 1e6;

/**
 * Opens an ACP session on a harness process: initialize, then `session/new` (or
 * `session/resume` of an earlier session). The session records what happens as
 * product-neutral transcript entries (secrets redacted) and allows tool permissions
 * once (the sandbox is the boundary). Keep-alive requests make sure a quiet session
 * still carries traffic until it is closed, so idle connections are not cut.
 */
export async function openAcpSession(options: AcpSessionOptions): Promise<AcpSession | AcpFailure> {
  const { process, cwd, observer, keepAliveMs, sessionMeta, cancelGraceMs = 10_000, redact = (text) => text, onSession, resume } = options;
  const meta = sessionMeta ? { _meta: sessionMeta } : {};
  const failed = (error: string): AcpFailure => {
    observer.record({ type: "error", message: error });
    return { outcome: "error", error };
  };
  const stderr = collect(process.stderr, (line) => observer.record({ type: "harness-output", text: redact(line) }));

  let reply = "";
  let cost: Cost | undefined;
  const connection = acp
    .client({ name: "tendworks-agent-runtime" })
    .onNotification(acp.methods.client.session.update, ({ params: { update } }) => {
      for (const entry of transcriptEntries(update, redact)) observer.record(entry);
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
        // Recorded above as far as they concern the agent's work, but they neither add to the reply nor change the cost: the agent's
        // thoughts, echoed user input, tool call progress, plans, modes, commands, session
        // metadata, compaction and subagent updates, and notices.
        case "agent_thought_chunk":
        case "user_message_chunk":
        case "tool_call_update":
        case "plan":
        case "plan_update":
        case "plan_removed":
        case "available_commands_update":
        case "current_mode_update":
        case "config_option_update":
        case "session_info_update":
        case "session_message":
        case "session_message_chunk":
        case "compaction_summary_chunk":
        case "compaction_update":
        case "subagent_update":
        case "notice":
          break;
      }
    })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      const option = params.options.find((o) => o.kind === "allow_once") ?? params.options.find((o) => o.kind === "allow_always");
      observer.record({ type: "permission", tool: redact(params.toolCall.title ?? params.toolCall.toolCallId), granted: option !== undefined });
      return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
    })
    .connect(acp.ndJsonStream(process.stdin, process.stdout));
  const agent = connection.agent;
  let open = true;
  const closed = connection.closed.then(() => {
    open = false;
    throw new HarnessClosed();
  });
  closed.catch(() => {});

  const timers: { keepAlive?: NodeJS.Timeout } = {};
  let shutDown: Promise<void> | undefined;
  const close = () =>
    (shutDown ??= (async () => {
      clearInterval(timers.keepAlive);
      // End the adapter cleanly: closing its input lets it dispose its session.
      connection.close();
      await process.stdin.close().catch(() => {});
      await Promise.race([process.exited.catch(() => {}), sleep(5_000)]);
    })());

  /** Why the harness stopped speaking: its answer with an error, or how it ended. */
  const failure = async (error: unknown): Promise<AcpFailure> => {
    if (!(error instanceof HarnessClosed) && !connection.signal.aborted) {
      // The harness answered with an error, e.g. missing authentication.
      return failed(redact(`the harness failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    // The harness ended; its exit code and error output say why.
    const exitCode = await Promise.race([process.exited.catch(() => undefined), sleep(1_000).then(() => undefined)]);
    await Promise.race([stderr.done, sleep(1_000)]);
    const code = exitCode === undefined ? "" : ` (exit code ${exitCode})`;
    const output = stderr.tail();
    return failed(redact(`the harness ended unexpectedly${code}${output ? `: ${output}` : ""}`));
  };

  let sessionId: string | undefined;
  let resumed = false;
  try {
    const init = await Promise.race([
      agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
      closed,
    ]);
    const harness = init.agentInfo ? { harness: { name: init.agentInfo.name, ...(init.agentInfo.version ? { version: init.agentInfo.version } : {}) } } : {};
    if (resume) {
      if (init.agentCapabilities?.sessionCapabilities?.resume) {
        try {
          await Promise.race([agent.request(acp.methods.agent.session.resume, { sessionId: resume.sessionId, cwd, mcpServers: [], ...meta }), closed]);
          sessionId = resume.sessionId;
          resumed = true;
          observer.record({ type: "session-resumed", sessionId, ...harness });
        } catch (error) {
          if (error instanceof HarnessClosed) throw error;
          const reason = redact(error instanceof Error ? error.message : String(error));
          observer.record({ type: "session-resume-failed", sessionId: resume.sessionId, reason });
        }
      } else {
        observer.record({ type: "session-resume-failed", sessionId: resume.sessionId, reason: "the agent cannot resume sessions" });
      }
    }
    if (sessionId === undefined) {
      sessionId = (await Promise.race([agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [], ...meta }), closed])).sessionId;
      observer.record({ type: "session-started", sessionId, ...harness });
    }
    await onSession?.(sessionId);
  } catch (error) {
    const failing = await failure(error);
    await close();
    return failing;
  }

  timers.keepAlive = setInterval(() => void agent.request(KEEP_ALIVE, {}).catch(() => {}), keepAliveMs);
  const id = sessionId;
  return {
    sessionId: id,
    resumed,
    get open() {
      return open && shutDown === undefined && !connection.signal.aborted;
    },
    async prompt(prompt, { timeoutMs }) {
      reply = "";
      const before = cost;
      let timeout: NodeJS.Timeout | undefined;
      try {
        const turn = agent.request(acp.methods.agent.session.prompt, { sessionId: id, prompt });
        turn.catch(() => {});
        const timedOut = new Promise<"timed-out">((resolve) => (timeout = setTimeout(() => resolve("timed-out"), timeoutMs)));
        const ended = await Promise.race([turn, closed, timedOut]);
        if (ended === "timed-out") {
          await agent.notify(acp.methods.agent.session.cancel, { sessionId: id }).catch(() => {});
          await Promise.race([turn.catch(() => {}), closed.catch(() => {}), sleep(cancelGraceMs)]);
          return failed(`the agent session timed out after ${Math.round(timeoutMs / 1000)} s and was cancelled`);
        }
        observer.record(turnEnded(ended.stopReason));
        // The session's cost is cumulative; this turn's is what it added.
        const added = cost && { amount: round(cost.amount - (before?.amount ?? 0)), currency: cost.currency };
        return { outcome: "stopped", sessionId: id, stopReason: ended.stopReason, reply: reply.trim(), ...(added ? { cost: added } : {}) };
      } catch (error) {
        return await failure(error);
      } finally {
        clearTimeout(timeout);
      }
    },
    close,
  };
}

/**
 * Drives one prompt turn over ACP on a fresh harness process: opens the session (or
 * resumes an earlier one, prompted with `resume.prompt` then), prompts it once and ends
 * the process.
 */
export async function runAcpTurn(options: AcpTurnOptions): Promise<AcpTurn> {
  const { prompt, timeoutMs, resume, ...rest } = options;
  const session = await openAcpSession({ ...rest, ...(resume ? { resume: { sessionId: resume.sessionId } } : {}) });
  if ("outcome" in session) return session;
  try {
    return await session.prompt(session.resumed && resume ? resume.prompt : prompt, { timeoutMs });
  } finally {
    await session.close();
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
