import * as acp from "@agentclientprotocol/sdk";
import type { A2A, AgentProfile } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { describeAgentTasks } from "../agent-tasks.suite.js";
import type { HarnessObserver } from "../harness.js";
import { describeHarness } from "../harness.suite.js";
import {
  createAgentRuntime,
  createClaudeCodeHarness,
  createInMemoryTranscriptStore,
  type ClaudeCodeCredential,
  type ClaudeCodeHarnessOptions,
} from "../index.js";
import type { ExecRequest, Sandboxes, SandboxProcess, SandboxTemplate } from "../sandboxes.js";
import type { TranscriptEntry } from "../transcripts/transcript-store.js";

/*
 * The Claude Code harness against a fake sandbox backend whose "claude-agent-acp"
 * process is a scripted ACP agent built with the ACP SDK. This exercises the real ACP
 * client without Docker, Claude or credentials; the real adapter runs in the manual
 * smoke test (docs/platform-implementation.md).
 */

interface AgentScript {
  /** Text chunks the agent sends before it ends its turn. */
  reply?: string[];
  cost?: number;
  stopReason?: acp.StopReason;
  /** How long the turn takes. */
  delayMs?: number;
  /** Asks for permission to run a tool before answering. */
  askPermission?: boolean;
  /** Writes this to stderr and exits with 1 instead of speaking ACP. */
  crash?: string;
  /** Ends the turn only when cancelled. */
  hang?: boolean;
}

interface Observed {
  initialize?: acp.InitializeRequest;
  newSession?: acp.NewSessionRequest;
  prompts: acp.PromptRequest[];
  keepAlives: number;
  cancelled: boolean;
  permission?: acp.RequestPermissionResponse;
}

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function startFakeAgent(script: AgentScript, observed: Observed): SandboxProcess {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const fromAgent = new TransformStream<Uint8Array, Uint8Array>();
  const stderr = new TransformStream<Uint8Array, Uint8Array>();

  if (script.crash !== undefined) {
    const writer = stderr.writable.getWriter();
    void writer.write(encode(`${script.crash}\n`)).then(() => writer.close());
    void fromAgent.writable.close();
    void toAgent.readable.cancel();
    return { stdin: toAgent.writable, stdout: fromAgent.readable, stderr: stderr.readable, exited: Promise.resolve(1) };
  }
  void stderr.writable.close();

  const update = (ctx: { client: acp.AgentContext; params: { sessionId: string } }, sessionUpdate: acp.SessionUpdate) =>
    ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update: sessionUpdate });
  let cancel: () => void = () => {};

  const connection = acp
    .agent({ name: "fake-claude-agent-acp" })
    .onRequest(acp.methods.agent.initialize, (ctx) => {
      observed.initialize = ctx.params;
      return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { resume: {} } } };
    })
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      observed.newSession = ctx.params;
      return { sessionId: "session-1" };
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      observed.prompts.push(ctx.params);
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
      if (script.hang) {
        await cancelled;
        return { stopReason: "cancelled" };
      }
      if (script.delayMs) await new Promise((resolve) => setTimeout(resolve, script.delayMs));
      for (const text of script.reply ?? ["Hello"]) await update(ctx, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      await update(ctx, { sessionUpdate: "usage_update", used: 1000, size: 200000, cost: { amount: script.cost ?? 0.42, currency: "USD" } });
      return { stopReason: script.stopReason ?? "end_turn" };
    })
    .onNotification(acp.methods.agent.session.cancel, () => {
      observed.cancelled = true;
      cancel();
    })
    .onRequest("_tendworks/keepalive", (params) => params, () => {
      observed.keepAlives++;
      // Like the real adapter, which does not know the method.
      throw acp.RequestError.methodNotFound("_tendworks/keepalive");
    })
    .connect(acp.ndJsonStream(fromAgent.writable, toAgent.readable));

  return { stdin: toAgent.writable, stdout: fromAgent.readable, stderr: stderr.readable, exited: connection.closed.then(() => 0) };
}

interface Attached {
  sandboxId: string;
  request: ExecRequest;
  /** Files of the sandbox at the moment the process started. */
  files: Map<string, string>;
}

function fakeSandboxes(script: AgentScript = {}) {
  const sandboxes = new Map<string, Map<string, Uint8Array>>();
  const created: SandboxTemplate[] = [];
  const destroyed: string[] = [];
  const attached: Attached[] = [];
  const observed: Observed = { prompts: [], keepAlives: 0, cancelled: false };
  const notFound = (message: string) => Object.assign(new Error(message), { code: "file-not-found" });
  const files = (id: string) => {
    const found = sandboxes.get(id);
    if (!found) throw Object.assign(new Error(`no sandbox ${id}`), { code: "sandbox-not-found" });
    return found;
  };

  const api: Sandboxes = {
    async create(template) {
      const id = `sandbox${created.length + 1}`;
      created.push(template);
      sandboxes.set(id, new Map());
      return { id };
    },
    async attach(sandboxId, request) {
      const snapshot = new Map([...files(sandboxId)].map(([path, content]) => [path, decode(content)]));
      attached.push({ sandboxId, request, files: snapshot });
      if (request.command[0] !== "claude-agent-acp") throw new Error(`unexpected command ${request.command.join(" ")}`);
      return startFakeAgent(script, observed);
    },
    async readFile(sandboxId, path) {
      const content = files(sandboxId).get(path);
      if (!content) throw notFound(`no file ${path}`);
      return content;
    },
    async writeFile(sandboxId, path, content) {
      files(sandboxId).set(path, content);
    },
    async destroy(sandboxId) {
      destroyed.push(sandboxId);
      sandboxes.delete(sandboxId);
    },
  };
  return { api, created, destroyed, attached, observed, sandboxes };
}

const template: SandboxTemplate = {
  apiVersion: "tendworks.dev/v1",
  kind: "SandboxTemplate",
  metadata: { name: "claude-code" },
  spec: { image: "tendworks/sandbox-claude-code:test" },
};

const profile = (sandbox: string | undefined = "claude-code"): AgentProfile.AgentProfile => ({
  apiVersion: "tendworks.dev/v1",
  kind: "AgentProfile",
  metadata: { name: "developer" },
  spec: { harness: "claude-code", ...(sandbox === undefined ? {} : { sandbox }) },
});

const oauth: ClaudeCodeCredential = { kind: "oauth-token", value: "oauth-secret-value" };

function harness(sandboxes: Sandboxes, options: Partial<ClaudeCodeHarnessOptions> = {}) {
  return createClaudeCodeHarness({
    sandboxes,
    templates: (name) => (name === template.metadata.name ? template : undefined),
    credential: oauth,
    ...options,
  });
}

function observe() {
  const entries: TranscriptEntry[] = [];
  const progress: string[] = [];
  const observer: HarnessObserver = { record: (entry) => entries.push(entry), progress: (text) => progress.push(text) };
  return { observer, entries, progress };
}

const message = (parts: A2A.Part[] = [{ text: "Create hello.txt" }]): A2A.Message => ({ messageId: "m-1", role: "ROLE_USER", parts });
const task = (overrides: { profile?: AgentProfile.AgentProfile; parts?: A2A.Part[] } = {}) => ({
  taskId: "task-1",
  profile: overrides.profile ?? profile(),
  message: message(overrides.parts),
});

describeHarness("Claude Code over ACP (scripted agent)", () => ({
  harness: harness(fakeSandboxes({ reply: ["Hello"] }).api),
  profile: profile(),
  reply: "Hello",
}));

describeAgentTasks("agent runtime with the Claude Code harness (scripted agent)", () => {
  const transcripts = createInMemoryTranscriptStore();
  const agents = createAgentRuntime({
    profiles: [profile()],
    harnesses: { "claude-code": harness(fakeSandboxes().api) },
    transcripts,
  });
  return { agents, agent: "developer", transcripts };
});

describe("Claude Code harness", () => {
  it("starts the ACP adapter in a sandbox from the profile's template and works in the workspace", async () => {
    const sandboxes = fakeSandboxes();

    await harness(sandboxes.api).run(task({ parts: [{ text: "Create hello.txt" }, { data: { issue: { number: 7 } } }] }), observe().observer);

    expect(sandboxes.created).toEqual([template]);
    expect(sandboxes.attached[0]?.request).toMatchObject({ command: ["claude-agent-acp"], workingDirectory: "/workspace" });
    expect(sandboxes.observed.newSession).toMatchObject({ cwd: "/workspace", mcpServers: [] });
    expect(sandboxes.observed.prompts[0]?.prompt).toEqual([
      { type: "text", text: "Create hello.txt" },
      { type: "text", text: JSON.stringify({ issue: { number: 7 } }, null, 2) },
    ]);
  });

  it("destroys the sandbox at the end of the session", async () => {
    const sandboxes = fakeSandboxes();

    await harness(sandboxes.api).run(task(), observe().observer);

    expect(sandboxes.destroyed).toEqual(["sandbox1"]);
  });

  it.each<[ClaudeCodeCredential, string, string]>([
    [oauth, "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    [{ kind: "api-key", value: "api-key-secret-value" }, "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  ])("passes only the selected credential (%o) into the sandbox", async (credential, passed, withheld) => {
    const sandboxes = fakeSandboxes();

    await harness(sandboxes.api, { credential }).run(task(), observe().observer);

    const env = sandboxes.attached[0]?.request.env ?? {};
    expect(env[passed]).toBe(credential.value);
    expect(env).not.toHaveProperty(withheld);
  });

  it("passes a different model endpoint into the sandbox when one is configured", async () => {
    const sandboxes = fakeSandboxes();

    await harness(sandboxes.api, { baseUrl: "https://models.example.test" }).run(task(), observe().observer);

    expect(sandboxes.attached[0]?.request.env).toMatchObject({ ANTHROPIC_BASE_URL: "https://models.example.test" });
  });

  it("marks the harness onboarding as complete before the harness starts, so a fresh sandbox does not block", async () => {
    const sandboxes = fakeSandboxes();

    await harness(sandboxes.api).run(task(), observe().observer);

    const { files, request } = sandboxes.attached[0]!;
    const home = request.env?.HOME;
    const configDir = request.env?.CLAUDE_CONFIG_DIR;
    expect(home).toMatch(/^\//);
    expect(configDir).toMatch(/^\//);
    expect(JSON.parse(files.get(`${home}/.claude.json`)!)).toEqual({ hasCompletedOnboarding: true });
    expect(JSON.parse(files.get(`${configDir}/.claude.json`)!)).toEqual({ hasCompletedOnboarding: true });
    expect(JSON.parse(files.get(`${configDir}/settings.json`)!)).toEqual({ permissions: { defaultMode: "bypassPermissions" } });
  });

  it("keeps what an existing harness configuration already holds", async () => {
    const sandboxes = fakeSandboxes();
    const original = sandboxes.api.create;
    sandboxes.api.create = async (t) => {
      const created = await original(t);
      await sandboxes.api.writeFile(created.id, "/session/claude/.claude.json", encode(JSON.stringify({ userID: "abc" })));
      await sandboxes.api.writeFile(created.id, "/session/claude/settings.json", encode(JSON.stringify({ model: "opus" })));
      return created;
    };

    await harness(sandboxes.api).run(task(), observe().observer);

    const { files } = sandboxes.attached[0]!;
    expect(JSON.parse(files.get("/session/claude/.claude.json")!)).toEqual({ userID: "abc", hasCompletedOnboarding: true });
    expect(JSON.parse(files.get("/session/claude/settings.json")!)).toEqual({ model: "opus", permissions: { defaultMode: "bypassPermissions" } });
  });

  it("fails the task without creating a sandbox when no credential is configured", async () => {
    const sandboxes = fakeSandboxes();

    const result = await harness(sandboxes.api, { credential: undefined }).run(task(), observe().observer);

    expect(result.state).toBe("TASK_STATE_FAILED");
    expect(result.message).toContain("TEND_CLAUDE_CODE_CREDENTIAL");
    expect(sandboxes.created).toEqual([]);
  });

  it("fails the task when the profile's sandbox template does not exist", async () => {
    const sandboxes = fakeSandboxes();

    const result = await harness(sandboxes.api).run(task({ profile: profile("nowhere") }), observe().observer);

    expect(result).toMatchObject({ state: "TASK_STATE_FAILED", message: expect.stringContaining("nowhere") });
    expect(sandboxes.created).toEqual([]);
  });

  it("fails the task with the harness's last error output when it exits early, without revealing the credential", async () => {
    const sandboxes = fakeSandboxes({ crash: `fatal: cannot start with token ${oauth.value}` });

    const result = await harness(sandboxes.api).run(task(), observe().observer);

    expect(result.state).toBe("TASK_STATE_FAILED");
    expect(result.message).toContain("fatal: cannot start");
    expect(result.message).not.toContain(oauth.value);
    expect(sandboxes.destroyed).toEqual(["sandbox1"]);
  });

  it("answers with the text the agent wrote after its last tool call and records every update", async () => {
    const sandboxes = fakeSandboxes({ reply: ["Created ", "hello.txt."] });
    const { observer, entries } = observe();

    const result = await harness(sandboxes.api).run(task(), observer);

    expect(result).toMatchObject({ state: "TASK_STATE_COMPLETED", message: "Created hello.txt.", cost: { amount: 0.42, currency: "USD" } });
    expect(entries.filter((entry) => entry.type === "acp-update").map((entry) => (entry.update as acp.SessionUpdate).sessionUpdate)).toEqual([
      "tool_call",
      "agent_message_chunk",
      "agent_message_chunk",
      "usage_update",
    ]);
  });

  it("allows what the agent asks permission for, once", async () => {
    const sandboxes = fakeSandboxes({ askPermission: true });

    await harness(sandboxes.api).run(task(), observe().observer);

    expect(sandboxes.observed.permission).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
  });

  it.each<[acp.StopReason, string]>([
    ["refusal", "TASK_STATE_REJECTED"],
    ["max_tokens", "TASK_STATE_FAILED"],
    ["max_turn_requests", "TASK_STATE_FAILED"],
  ])("ends a turn stopped by %s in %s", async (stopReason, state) => {
    const result = await harness(fakeSandboxes({ stopReason }).api).run(task(), observe().observer);

    expect(result.state).toBe(state);
  });

  it("keeps a quiet session alive with requests the harness answers, so idle connections are not cut", async () => {
    const sandboxes = fakeSandboxes({ delayMs: 120 });

    const result = await harness(sandboxes.api, { keepAliveMs: 20 }).run(task(), observe().observer);

    expect(result.state).toBe("TASK_STATE_COMPLETED");
    expect(sandboxes.observed.keepAlives).toBeGreaterThanOrEqual(3);
  });

  it("cancels a session that runs longer than allowed and fails the task", async () => {
    const sandboxes = fakeSandboxes({ hang: true });

    const result = await harness(sandboxes.api, { timeoutMs: 50 }).run(task(), observe().observer);

    expect(result).toMatchObject({ state: "TASK_STATE_FAILED", message: expect.stringContaining("time") });
    expect(sandboxes.observed.cancelled).toBe(true);
    expect(sandboxes.destroyed).toEqual(["sandbox1"]);
  });
});
