import * as acp from "@agentclientprotocol/sdk";
import type { ExecRequest, ExecResult, Sandboxes, SandboxProcess, SandboxTemplate, VolumeMount } from "../sandboxes.js";

/*
 * A fake sandbox backend whose "claude-agent-acp" process is a scripted ACP agent built
 * with the ACP SDK. Tests of the Claude Code harness and of the agent runtime use it to
 * exercise the real ACP client without Docker, Claude or credentials; the real adapter
 * runs in the manual smoke test (docs/platform-implementation.md).
 */

export interface AgentScript {
  /** Text chunks the agent sends before it ends its turn. */
  reply?: string[];
  /** Further session updates the agent sends after its tool call, before it hangs or replies. */
  updates?: acp.SessionUpdate[];
  cost?: number;
  stopReason?: acp.StopReason;
  /** How long the turn takes. */
  delayMs?: number;
  /** Asks for permission to run a tool before answering. */
  askPermission?: boolean;
  /** Writes this to stderr and exits with 1 instead of speaking ACP. */
  crash?: string;
  /** Ends the turn only when cancelled: every turn (`true`) or only the first one of all processes. */
  hang?: boolean | "first";
  /** Takes note of `session/cancel` but goes on working, so a hanging turn never ends. */
  ignoreCancel?: boolean;
  /** Does not advertise the ACP resume capability. */
  noResume?: boolean;
  /** Does not advertise that it connects to MCP servers over HTTP. */
  noMcp?: boolean;
  /** Written to the file named by TENDWORKS_ARTIFACTS before the turn ends. */
  artifacts?: string;
  /**
   * Answers with every prompt of the session so far, one per line after "I remember:",
   * instead of `reply`: what it remembers lives in its session file, like Claude Code's.
   */
  recall?: boolean;
}

/** What the scripted agent was asked, across all its processes. */
export interface Observed {
  initialize?: acp.InitializeRequest;
  newSession?: acp.NewSessionRequest;
  resumed: acp.ResumeSessionRequest[];
  prompts: acp.PromptRequest[];
  keepAlives: number;
  cancelled: boolean;
  permission?: acp.RequestPermissionResponse;
  sessions: number;
}

/** Files of the sandbox the scripted agent runs in, as the agent sees them. */
interface Disk {
  read(path: string): Uint8Array | undefined;
  write(path: string, content: Uint8Array): void;
}

export const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * A scripted ACP agent. Like Claude Code, it keeps each session as a file in its config
 * directory and can resume a session only while that file exists.
 */
function startScriptedAgent(script: AgentScript, observed: Observed, disk: Disk, env: Record<string, string>): SandboxProcess & { kill: () => void } {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const fromAgent = new TransformStream<Uint8Array, Uint8Array>();
  const stderr = new TransformStream<Uint8Array, Uint8Array>();

  if (script.crash !== undefined) {
    const writer = stderr.writable.getWriter();
    void writer.write(encode(`${script.crash}\n`)).then(() => writer.close());
    void fromAgent.writable.close();
    void toAgent.readable.cancel();
    return { stdin: toAgent.writable, stdout: fromAgent.readable, stderr: stderr.readable, exited: Promise.resolve(1), kill: () => {} };
  }
  void stderr.writable.close();

  const update = (ctx: { client: acp.AgentContext; params: { sessionId: string } }, sessionUpdate: acp.SessionUpdate) =>
    ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update: sessionUpdate });
  let cancel: () => void = () => {};
  let cost = 0;
  const sessionFile = (sessionId: string) => `${env.CLAUDE_CONFIG_DIR}/projects/${sessionId}.jsonl`;

  const connection = acp
    .agent({ name: "fake-claude-agent-acp" })
    .onRequest(acp.methods.agent.initialize, (ctx) => {
      observed.initialize = ctx.params;
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: "scripted-agent", version: "1.0.0" },
        agentCapabilities: { sessionCapabilities: script.noResume ? {} : { resume: {} }, ...(script.noMcp ? {} : { mcpCapabilities: { http: true } }) },
      };
    })
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      observed.newSession = ctx.params;
      const sessionId = `session-${++observed.sessions}`;
      disk.write(sessionFile(sessionId), encode(`${JSON.stringify({ cwd: ctx.params.cwd })}\n`));
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.resume, (ctx) => {
      if (!disk.read(sessionFile(ctx.params.sessionId))) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
      observed.resumed.push(ctx.params);
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      observed.prompts.push(ctx.params);
      const file = sessionFile(ctx.params.sessionId);
      const said = ctx.params.prompt.map((block) => (block.type === "text" ? block.text : "")).join(" ");
      const remembered = `${decode(disk.read(file) ?? new Uint8Array())}${JSON.stringify({ prompt: said })}\n`;
      disk.write(file, encode(remembered));
      const hang = script.hang === true || (script.hang === "first" && observed.prompts.length === 1);
      const cancelled = new Promise<void>((resolve) => (cancel = resolve));
      if (script.askPermission) {
        observed.permission = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: { toolCallId: "tool-1", title: "Write hello.txt" },
          options: [
            { optionId: "no", name: "Reject", kind: "reject_once" },
            { optionId: "yes-always", name: "Always allow", kind: "allow_always" },
            { optionId: "yes", name: "Allow", kind: "allow_once" },
          ],
        });
      }
      await update(ctx, { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Write hello.txt", status: "completed" });
      for (const extra of script.updates ?? []) await update(ctx, extra);
      if (hang) {
        await cancelled;
        return { stopReason: "cancelled" };
      }
      if (script.delayMs) await new Promise((resolve) => setTimeout(resolve, script.delayMs));
      const prompts = remembered
        .split("\n")
        .filter((line) => line.includes('"prompt"'))
        .map((line) => (JSON.parse(line) as { prompt: string }).prompt);
      const reply = script.recall ? [`I remember: ${prompts.join(" | ")}`] : (script.reply ?? ["Hello"]);
      for (const text of reply) await update(ctx, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      if (script.artifacts !== undefined) disk.write(env.TENDWORKS_ARTIFACTS!, encode(script.artifacts));
      // Cumulative for the session, as ACP defines it; this process knows only its own turns.
      cost += script.cost ?? 0.42;
      await update(ctx, { sessionUpdate: "usage_update", used: 1000, size: 200000, cost: { amount: cost, currency: "USD" } });
      return { stopReason: script.stopReason ?? "end_turn" };
    })
    .onNotification(acp.methods.agent.session.cancel, () => {
      observed.cancelled = true;
      if (!script.ignoreCancel) cancel();
    })
    .onRequest("_tendworks/keepalive", (params) => params, () => {
      observed.keepAlives++;
      // Like the real adapter, which does not know the method.
      throw acp.RequestError.methodNotFound("_tendworks/keepalive");
    })
    .connect(acp.ndJsonStream(fromAgent.writable, toAgent.readable));

  const process = { stdin: toAgent.writable, stdout: fromAgent.readable, stderr: stderr.readable, exited: connection.closed.then(() => 0) };
  // The sandbox goes away under the agent.
  const kill = () => {
    void fromAgent.writable.abort().catch(() => {});
    void toAgent.readable.cancel().catch(() => {});
  };
  return Object.assign(process, { kill });
}

export interface Attached {
  sandboxId: string;
  request: ExecRequest;
  /** Files of the sandbox at the moment the process started, volumes included. */
  files: Map<string, string>;
}

type Files = Map<string, Uint8Array>;

interface FakeSandbox {
  files: Files;
  /** Volumes by mount path; their files by absolute path in the sandbox. */
  mounts: { path: string; files: Files }[];
  kill: () => void;
}

/**
 * Sandboxes in memory with named volumes, in which `claude-agent-acp` starts the scripted
 * agent. Records what was created, attached, executed, destroyed and deleted.
 */
export function scriptedSandboxes(
  script: AgentScript = {},
  /** What a command run with `exec` does; it may write files into the sandbox, e.g. a checkout into the workspace. */
  execResult: (request: ExecRequest, sandbox: Pick<Disk, "write">) => ExecResult = () => ({ exitCode: 0, stdout: "", stderr: "" }),
) {
  const sandboxes = new Map<string, FakeSandbox>();
  const volumes = new Map<string, Files>();
  const created: { template: SandboxTemplate; volumes: VolumeMount[]; owner?: string }[] = [];
  const destroyed: string[] = [];
  const deletedVolumes: string[] = [];
  const attached: Attached[] = [];
  const execs: { sandboxId: string; request: ExecRequest }[] = [];
  const observed: Observed = { resumed: [], prompts: [], keepAlives: 0, cancelled: false, sessions: 0 };
  const notFound = (message: string) => Object.assign(new Error(message), { code: "file-not-found" });
  const find = (id: string) => {
    const found = sandboxes.get(id);
    if (!found) throw Object.assign(new Error(`no sandbox ${id}`), { code: "sandbox-not-found" });
    return found;
  };
  const filesFor = (sandbox: FakeSandbox, path: string) => sandbox.mounts.find((mount) => path.startsWith(`${mount.path}/`))?.files ?? sandbox.files;

  const api: Sandboxes = {
    async create(template, options = {}) {
      const id = `sandbox${created.length + 1}`;
      created.push({ template, volumes: options.volumes ?? [], ...(options.owner === undefined ? {} : { owner: options.owner }) });
      const mounts = (options.volumes ?? []).map(({ volume, path }) => {
        if (!volumes.has(volume)) volumes.set(volume, new Map());
        return { path, files: volumes.get(volume)! };
      });
      sandboxes.set(id, { files: new Map(), mounts, kill: () => {} });
      return { id };
    },
    async attach(sandboxId, request) {
      const sandbox = find(sandboxId);
      const all = [sandbox.files, ...sandbox.mounts.map(({ files }) => files)].flatMap((files) => [...files]);
      attached.push({ sandboxId, request, files: new Map(all.map(([path, content]) => [path, decode(content)])) });
      if (request.command[0] !== "claude-agent-acp") throw new Error(`unexpected command ${request.command.join(" ")}`);
      const disk: Disk = {
        read: (path) => filesFor(sandbox, path).get(path),
        write: (path, content) => void filesFor(sandbox, path).set(path, content),
      };
      const process = startScriptedAgent(script, observed, disk, request.env ?? {});
      sandbox.kill = process.kill;
      return process;
    },
    async exec(sandboxId, request) {
      const sandbox = find(sandboxId);
      execs.push({ sandboxId, request });
      return execResult(request, { write: (path, content) => void filesFor(sandbox, path).set(path, content) });
    },
    async readFile(sandboxId, path) {
      const content = filesFor(find(sandboxId), path).get(path);
      if (!content) throw notFound(`no file ${path}`);
      return content;
    },
    async writeFile(sandboxId, path, content) {
      filesFor(find(sandboxId), path).set(path, content);
    },
    async destroy(sandboxId) {
      destroyed.push(sandboxId);
      sandboxes.get(sandboxId)?.kill();
      sandboxes.delete(sandboxId);
    },
    async deleteVolume(volume) {
      deletedVolumes.push(volume);
      volumes.delete(volume);
    },
  };
  return { api, created, destroyed, deletedVolumes, attached, execs, observed, sandboxes, volumes };
}

/**
 * The sandbox API as a worker that dies sees it: once `die()` is called, no call of
 * this worker reaches the sandboxes any more, so it cannot clean up after itself.
 */
export function dyingWorker(api: Sandboxes) {
  let dead = false;
  const never = new Promise<never>(() => {});
  const guarded = Object.fromEntries(
    Object.entries(api).map(([name, call]) => [name, (...args: unknown[]) => (dead ? never : (call as (...a: unknown[]) => unknown)(...args))]),
  ) as unknown as Sandboxes;
  return { api: guarded, die: () => void (dead = true) };
}

/** The sandbox template the scripted agent's profiles use. */
export const scriptedTemplate: SandboxTemplate = {
  apiVersion: "tendworks.dev/v1",
  kind: "SandboxTemplate",
  metadata: { name: "claude-code" },
  spec: { image: "tendworks/sandbox-claude-code:test" },
};
