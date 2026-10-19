import * as acp from "@agentclientprotocol/sdk";
import { createSecretResolver } from "@tendworks/platform";
import type { A2A, AgentProfile } from "@tendworks/shared";
import { describe, expect, it, vi } from "vitest";
import { describeAgentTasks } from "../agent-tasks.suite.js";
import type { HarnessObserver, HarnessSession } from "../harness.js";
import { describeHarness } from "../harness.suite.js";
import {
  createAgentRuntime,
  createClaudeCodeHarness,
  createInMemoryTranscriptStore,
  type ClaudeCodeCredential,
  type ClaudeCodeHarnessOptions,
  type LoadedAgentProfile,
} from "../index.js";
import type { ExecRequest, ExecResult, Sandboxes, SandboxProcess, SandboxTemplate, VolumeMount } from "../sandboxes.js";
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
  /** Ends the turn only when cancelled: every turn (`true`) or only the first one of all processes. */
  hang?: boolean | "first";
  /** Does not advertise the ACP resume capability. */
  noResume?: boolean;
  /** Written to the file named by TENDWORKS_ARTIFACTS before the turn ends. */
  artifacts?: string;
}

interface Observed {
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

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * A scripted ACP agent. Like Claude Code, it keeps each session as a file in its config
 * directory and can resume a session only while that file exists.
 */
function startFakeAgent(script: AgentScript, observed: Observed, disk: Disk, env: Record<string, string>): SandboxProcess & { kill: () => void } {
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
  const sessionFile = (sessionId: string) => `${env.CLAUDE_CONFIG_DIR}/projects/${sessionId}.jsonl`;

  const connection = acp
    .agent({ name: "fake-claude-agent-acp" })
    .onRequest(acp.methods.agent.initialize, (ctx) => {
      observed.initialize = ctx.params;
      return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: script.noResume ? {} : { resume: {} } } };
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
      if (hang) {
        await cancelled;
        return { stopReason: "cancelled" };
      }
      if (script.delayMs) await new Promise((resolve) => setTimeout(resolve, script.delayMs));
      for (const text of script.reply ?? ["Hello"]) await update(ctx, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      if (script.artifacts !== undefined) disk.write(env.TENDWORKS_ARTIFACTS!, encode(script.artifacts));
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

  const process = { stdin: toAgent.writable, stdout: fromAgent.readable, stderr: stderr.readable, exited: connection.closed.then(() => 0) };
  // The sandbox goes away under the agent.
  const kill = () => {
    void fromAgent.writable.abort().catch(() => {});
    void toAgent.readable.cancel().catch(() => {});
  };
  return Object.assign(process, { kill });
}

interface Attached {
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

function fakeSandboxes(
  script: AgentScript = {},
  execResult: (request: ExecRequest) => ExecResult = () => ({ exitCode: 0, stdout: "", stderr: "" }),
) {
  const sandboxes = new Map<string, FakeSandbox>();
  const volumes = new Map<string, Files>();
  const created: { template: SandboxTemplate; volumes: VolumeMount[] }[] = [];
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
      created.push({ template, volumes: options.volumes ?? [] });
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
      const process = startFakeAgent(script, observed, disk, request.env ?? {});
      sandbox.kill = process.kill;
      return process;
    },
    async exec(sandboxId, request) {
      find(sandboxId);
      execs.push({ sandboxId, request });
      return execResult(request);
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
function dyingWorker(api: Sandboxes) {
  let dead = false;
  const never = new Promise<never>(() => {});
  const guarded = Object.fromEntries(
    Object.entries(api).map(([name, call]) => [name, (...args: unknown[]) => (dead ? never : (call as (...a: unknown[]) => unknown)(...args))]),
  ) as unknown as Sandboxes;
  return { api: guarded, die: () => void (dead = true) };
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
  /** Every session the harness kept, with what had been prompted by then. */
  const sessions: HarnessSession[] = [];
  const waiting: { until: (session: HarnessSession) => boolean; resolve: (session: HarnessSession) => void }[] = [];
  const observer: HarnessObserver = {
    record: (entry) => entries.push(entry),
    progress: (text) => progress.push(text),
    saveSession: async (session) => {
      sessions.push(session);
      for (const wait of waiting.filter(({ until }) => until(session))) wait.resolve(session);
    },
  };
  /** Resolves once the harness keeps a session with an ACP session id, e.g. to interrupt it then. */
  const saved = () =>
    new Promise<HarnessSession>((resolve) => waiting.push({ until: (session) => session.sessionId !== undefined, resolve }));
  return { observer, entries, progress, sessions, saved };
}

const message = (parts: A2A.Part[] = [{ text: "Create hello.txt" }]): A2A.Message => ({ messageId: "m-1", role: "ROLE_USER", parts });
const task = (overrides: { profile?: AgentProfile.AgentProfile; parts?: A2A.Part[]; session?: HarnessSession } = {}) => ({
  taskId: "task-1",
  profile: overrides.profile ?? profile(),
  message: message(overrides.parts),
  ...(overrides.session ? { session: overrides.session } : {}),
});

const pullRequest = { name: "pull-request", url: "https://git.example/acme/app/pull/1" };

describeHarness("Claude Code over ACP (scripted agent)", () => ({
  harness: harness(fakeSandboxes({ reply: ["Hello"], artifacts: JSON.stringify([pullRequest]) }).api),
  profile: profile(),
  reply: "Hello",
  reported: pullRequest,
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

    expect(sandboxes.created.map((c) => c.template)).toEqual([template]);
    expect(sandboxes.attached[0]?.request).toMatchObject({ command: ["claude-agent-acp"], workingDirectory: "/workspace" });
    expect(sandboxes.observed.newSession).toMatchObject({ cwd: "/workspace", mcpServers: [] });
    expect(sandboxes.observed.prompts[0]?.prompt).toEqual([
      { type: "text", text: "Create hello.txt" },
      { type: "text", text: JSON.stringify({ issue: { number: 7 } }, null, 2) },
    ]);
  });

  it("keeps the workspace and the harness's home and config directory on volumes of the agent session", async () => {
    const sandboxes = fakeSandboxes();

    await harness(sandboxes.api).run(task(), observe().observer);

    expect(sandboxes.created[0]?.volumes).toEqual([
      { volume: "task-1-workspace", path: "/workspace" },
      { volume: "task-1-session", path: "/session" },
    ]);
    expect(sandboxes.attached[0]?.request.env).toMatchObject({ HOME: expect.stringMatching(/^\/session\//), CLAUDE_CONFIG_DIR: expect.stringMatching(/^\/session\//) });
  });

  it("deletes the volumes of the agent session after the sandbox when the session ends", async () => {
    const sandboxes = fakeSandboxes();

    await harness(sandboxes.api).run(task(), observe().observer);

    expect(sandboxes.destroyed).toEqual(["sandbox1"]);
    expect(sandboxes.deletedVolumes.sort()).toEqual(["task-1-session", "task-1-workspace"]);
  });

  it("keeps the ACP session id and the sandbox with the task before the agent gets the prompt", async () => {
    const sandboxes = fakeSandboxes();
    const { observer, sessions, saved } = observe();
    const prompted = saved().then(() => sandboxes.observed.prompts.length);

    await harness(sandboxes.api).run(task(), observer);

    expect(await prompted).toBe(0);
    expect(sessions.at(-1)).toEqual({ sessionId: "session-1", sandboxId: "sandbox1" });
  });

  it("resumes the kept ACP session in a new sandbox on the same volumes after a restart and completes the task", async () => {
    const sandboxes = fakeSandboxes({ hang: "first", reply: ["Finished hello.txt."] });
    // The first worker starts the session and dies while the agent works on the prompt.
    const before = dyingWorker(sandboxes.api);
    const first = observe();
    const kept = first.saved();
    void harness(before.api).run(task(), first.observer);
    const session = await kept;
    await vi.waitFor(() => expect(sandboxes.observed.prompts).toHaveLength(1));
    before.die();

    const after = observe();
    const result = await harness(sandboxes.api).run(task({ session }), after.observer);

    expect(result).toMatchObject({ state: "TASK_STATE_COMPLETED", message: "Finished hello.txt." });
    // The abandoned sandbox goes before a new one mounts the session's volumes.
    expect(sandboxes.destroyed[0]).toBe("sandbox1");
    expect(sandboxes.created.map((c) => c.volumes)).toEqual([sandboxes.created[0]!.volumes, sandboxes.created[0]!.volumes]);
    expect(sandboxes.observed.sessions).toBe(1);
    expect(sandboxes.observed.resumed).toMatchObject([{ sessionId: "session-1", cwd: "/workspace", mcpServers: [], _meta: { systemPrompt: { append: expect.any(String) } } }]);
    expect(sandboxes.observed.prompts[1]).toMatchObject({
      sessionId: "session-1",
      prompt: [{ type: "text", text: expect.stringMatching(/continue/i) }],
    });
    expect(after.sessions.at(-1)).toEqual({ sessionId: "session-1", sandboxId: "sandbox2" });
    expect(after.entries).toContainEqual(expect.objectContaining({ type: "acp-session-resumed", sessionId: "session-1" }));
    expect(sandboxes.deletedVolumes.sort()).toEqual(["task-1-session", "task-1-workspace"]);
  });

  it.each<[string, AgentScript]>([
    ["the agent no longer knows the session", {}],
    ["the agent cannot resume sessions", { noResume: true }],
  ])("starts the task again in a new session on the kept volumes when %s", async (_, script) => {
    const sandboxes = fakeSandboxes(script);
    const { observer, entries, sessions } = observe();

    const result = await harness(sandboxes.api).run(task({ session: { sessionId: "lost-session", sandboxId: "sandbox0" } }), observer);

    expect(result.state).toBe("TASK_STATE_COMPLETED");
    expect(sandboxes.observed.prompts).toEqual([expect.objectContaining({ sessionId: "session-1", prompt: [{ type: "text", text: "Create hello.txt" }] })]);
    expect(entries).toContainEqual(expect.objectContaining({ type: "acp-resume-failed", sessionId: "lost-session" }));
    expect(sessions.at(-1)).toEqual({ sessionId: "session-1", sandboxId: "sandbox1" });
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

  it.each<[acp.StopReason, string, RegExp]>([
    ["refusal", "TASK_STATE_REJECTED", /./],
    ["max_tokens", "TASK_STATE_FAILED", /stopped early: it reached its token limit/],
    ["max_turn_requests", "TASK_STATE_FAILED", /stopped early: it reached its limit of model requests per turn/],
  ])("ends a turn stopped by %s in %s", async (stopReason, state, message) => {
    const result = await harness(fakeSandboxes({ stopReason }).api).run(task(), observe().observer);

    expect(result.state).toBe(state);
    expect(result.message).toMatch(message);
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

describe("Claude Code harness: the agent's role, skills, secrets and workspace", () => {
  const developer = (spec: Partial<AgentProfile.AgentProfileSpec> = {}, role?: string): LoadedAgentProfile => ({
    ...profile(),
    spec: { ...profile().spec, ...spec },
    ...(role === undefined ? {} : { role }),
  });
  const agentToken = "agent-token-secret-value";
  const secrets = createSecretResolver("agent", { TENDWORKS_AGENT_TOKEN: agentToken, TENDWORKS_PLATFORM_TOKEN: "platform-token" });
  const withToken = { env: { GH_TOKEN: { secretRef: { name: "TENDWORKS_AGENT_TOKEN" } } } };
  const workspace = { repository: "https://git.example/acme/app.git", branch: "tendworks/run-1" };
  const withWorkspace = (value: unknown = workspace): A2A.Message => ({ ...message(), metadata: { "dev.tendworks/workspace": value } });

  it("gives the agent its role description and how to report results as instructions for the session", async () => {
    const sandboxes = fakeSandboxes();

    await harness(sandboxes.api).run({ ...task(), profile: developer({}, "You are the developer.") }, observe().observer);

    const append = (sandboxes.observed.newSession?._meta?.systemPrompt as { append?: string } | undefined)?.append ?? "";
    expect(append).toContain("You are the developer.");
    expect(append).toContain("/session/artifacts.json");
    expect(sandboxes.attached[0]?.request.env).toMatchObject({ TENDWORKS_ARTIFACTS: "/session/artifacts.json" });
  });

  it("ignores a malformed artifacts file and records why", async () => {
    const sandboxes = fakeSandboxes({ artifacts: '{"url": "not a list"}' });
    const { observer, entries } = observe();

    const result = await harness(sandboxes.api).run(task(), observer);

    expect(result).toMatchObject({ state: "TASK_STATE_COMPLETED" });
    expect(result.artifacts).toBeUndefined();
    expect(entries).toContainEqual(expect.objectContaining({ type: "artifacts-ignored" }));
  });

  it("turns the harness's AI attribution off when the profile says so, over what the configuration already holds", async () => {
    const sandboxes = fakeSandboxes();
    const original = sandboxes.api.create;
    sandboxes.api.create = async (t) => {
      const created = await original(t);
      await sandboxes.api.writeFile(created.id, "/session/claude/settings.json", encode(JSON.stringify({ model: "opus", attribution: { commit: "Made by a robot" } })));
      return created;
    };

    await harness(sandboxes.api).run({ ...task(), profile: developer({ attribution: false }) }, observe().observer);

    const { files, request } = sandboxes.attached[0]!;
    expect(JSON.parse(files.get(`${request.env?.CLAUDE_CONFIG_DIR}/settings.json`)!)).toEqual({
      model: "opus",
      permissions: { defaultMode: "bypassPermissions" },
      attribution: { commit: "", pr: "", sessionUrl: false },
    });
  });

  it("copies the profile's skills into the harness's config directory before the harness starts", async () => {
    const sandboxes = fakeSandboxes();
    const skills = new Map([["tdd", [{ path: "SKILL.md", content: encode("Red, green.") }, { path: "refs/mocking.md", content: encode("Mock less.") }]]]);

    await harness(sandboxes.api, { skills }).run({ ...task(), profile: developer({ skills: ["tdd"] }) }, observe().observer);

    const { files, request } = sandboxes.attached[0]!;
    expect(files.get(`${request.env?.CLAUDE_CONFIG_DIR}/skills/tdd/SKILL.md`)).toBe("Red, green.");
    expect(files.get(`${request.env?.CLAUDE_CONFIG_DIR}/skills/tdd/refs/mocking.md`)).toBe("Mock less.");
  });

  it("fails the task without a sandbox when a skill of the profile is not loaded", async () => {
    const sandboxes = fakeSandboxes();

    const result = await harness(sandboxes.api).run({ ...task(), profile: developer({ skills: ["tdd"] }) }, observe().observer);

    expect(result).toMatchObject({ state: "TASK_STATE_FAILED", message: expect.stringContaining("tdd") });
    expect(sandboxes.created).toEqual([]);
  });

  it("passes the secrets the profile lists into the sandbox under the names it gives them", async () => {
    const sandboxes = fakeSandboxes();

    await harness(sandboxes.api, { secrets }).run({ ...task(), profile: developer(withToken) }, observe().observer);

    const env = sandboxes.attached[0]?.request.env ?? {};
    expect(env.GH_TOKEN).toBe(agentToken);
    expect(env).not.toHaveProperty("TENDWORKS_AGENT_TOKEN");
  });

  it("fails the task without a sandbox when a secret the profile lists is missing, naming it but no value", async () => {
    const sandboxes = fakeSandboxes();

    const result = await harness(sandboxes.api, { secrets }).run(
      { ...task(), profile: developer({ env: { GH_TOKEN: { secretRef: { name: "TENDWORKS_AGENT_NOT_SET" } } } }) },
      observe().observer,
    );

    expect(result).toMatchObject({ state: "TASK_STATE_FAILED", message: "agent profile developer: secret TENDWORKS_AGENT_NOT_SET is not set" });
    expect(sandboxes.created).toEqual([]);
  });

  it("fails the task without a sandbox when the profile references a secret not meant for agents", async () => {
    const sandboxes = fakeSandboxes();

    const result = await harness(sandboxes.api, { secrets }).run(
      { ...task(), profile: developer({ env: { GH_TOKEN: { secretRef: { name: "TENDWORKS_PLATFORM_TOKEN" } } } }) },
      observe().observer,
    );

    expect(result).toMatchObject({ state: "TASK_STATE_FAILED", message: expect.stringContaining("TENDWORKS_PLATFORM_TOKEN is not an agent secret") });
    expect(result.message).not.toContain("platform-token");
    expect(sandboxes.created).toEqual([]);
  });

  it("never reveals a secret of the profile in what it reports", async () => {
    const sandboxes = fakeSandboxes({ crash: `fatal: push refused for ${agentToken}` });
    const { observer, entries } = observe();

    const result = await harness(sandboxes.api, { secrets }).run({ ...task(), profile: developer(withToken) }, observer);

    expect(result.message).toContain("fatal: push refused");
    expect(result.message).not.toContain(agentToken);
    expect(JSON.stringify(entries)).not.toContain(agentToken);
  });

  it("checks the workspace out in the sandbox, with the profile's secrets, before the harness starts", async () => {
    const sandboxes = fakeSandboxes();

    await harness(sandboxes.api, { secrets }).run({ taskId: "task-1", message: withWorkspace(), profile: developer(withToken) }, observe().observer);

    expect(sandboxes.execs).toHaveLength(1);
    const { request } = sandboxes.execs[0]!;
    expect(request.command.slice(-2)).toEqual([workspace.repository, workspace.branch]);
    expect(request).toMatchObject({ workingDirectory: "/workspace", env: { GH_TOKEN: agentToken } });
    expect(sandboxes.attached).toHaveLength(1);
  });

  it("does not touch the workspace when the task asks for none", async () => {
    const sandboxes = fakeSandboxes();

    await harness(sandboxes.api).run(task(), observe().observer);

    expect(sandboxes.execs).toEqual([]);
  });

  it("fails the task with the checkout's error output when the workspace cannot be checked out", async () => {
    const sandboxes = fakeSandboxes({}, () => ({ exitCode: 128, stdout: "", stderr: `fatal: could not read from ${agentToken}` }));

    const result = await harness(sandboxes.api, { secrets }).run(
      { taskId: "task-1", message: withWorkspace(), profile: developer(withToken) },
      observe().observer,
    );

    expect(result).toMatchObject({ state: "TASK_STATE_FAILED", message: expect.stringContaining("fatal: could not read") });
    expect(result.message).not.toContain(agentToken);
    expect(sandboxes.attached).toEqual([]);
    expect(sandboxes.destroyed).toEqual(["sandbox1"]);
  });

  it("fails the task when the workspace it asks for is malformed", async () => {
    const sandboxes = fakeSandboxes();

    const result = await harness(sandboxes.api).run({ taskId: "task-1", message: withWorkspace({ branch: "x" }), profile: developer() }, observe().observer);

    expect(result).toMatchObject({ state: "TASK_STATE_FAILED", message: expect.stringContaining("dev.tendworks/workspace") });
    expect(sandboxes.created).toEqual([]);
  });
});
