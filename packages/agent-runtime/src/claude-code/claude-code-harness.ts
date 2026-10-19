import type * as acp from "@agentclientprotocol/sdk";
import type { SecretResolver } from "@tendworks/platform";
import type { A2A } from "@tendworks/shared";
import { openAcpSession, runAcpTurn, type AcpSession, type AcpSessionOptions, type AcpTurn } from "../acp/acp-turn.js";
import type { LoadedAgentProfile } from "../agent-profiles.js";
import { parseReportedArtifacts, toArtifact } from "../artifacts.js";
import type { Harness, HarnessObserver, HarnessResult, HarnessSession } from "../harness.js";
import type { Sandboxes, SandboxProcess, SandboxTemplate, VolumeMount } from "../sandboxes.js";
import type { SkillFile } from "../skills.js";
import type { TranscriptRecord } from "../transcripts/transcript-store.js";
import { checkoutCommand, workspaceOf, type Workspace } from "../workspace.js";
import { CREDENTIAL_VARIABLES, type ClaudeCodeCredential } from "./credentials.js";

export interface ClaudeCodeHarnessOptions {
  sandboxes: Sandboxes;
  /** Looks up a sandbox template by name. */
  templates: (name: string) => SandboxTemplate | undefined;
  /** The one credential passed into the sandbox; undefined fails every task with a hint. */
  credential: ClaudeCodeCredential | undefined;
  /** Alternative model endpoint (`ANTHROPIC_BASE_URL`), e.g. a gateway. */
  baseUrl?: string;
  /** Skills of the configuration by name, copied into the sandbox for profiles that list them. */
  skills?: ReadonlyMap<string, SkillFile[]>;
  /** Resolves the secret references of a profile's `spec.env`: only agent secrets (ADR 0008). Without it none resolves. */
  secrets?: SecretResolver;
  /** How often a quiet session is kept alive; below the socket proxy's 10-minute idle cut. */
  keepAliveMs?: number;
  /** How long one session may run before it is cancelled and the task fails. */
  timeoutMs?: number;
  /**
   * The platform MCP server (ADR 0016): its address as sandboxes reach it and the read-only
   * token it is read with. Only sessions of profiles that list it (`mcp: [tendworks]`) get
   * either; without it, their tasks fail with a hint.
   */
  platformMcp?: { url: string; token: string };
  /** How long a cancelled turn of a chat gets to stop before its harness process is given up; 10 s by default. */
  cancelGraceMs?: number;
}

// Fixed paths inside the sandbox image (images/sandbox-claude-code). The workspace and
// /session, which holds the harness's home and config directory, are volumes of the
// agent session, so a new sandbox after a restart carries on with them.
export const WORKSPACE = "/workspace";
const SESSION = "/session";
const HOME = `${SESSION}/home`;
const CONFIG_DIR = `${SESSION}/claude`;
const ARTIFACTS = `${SESSION}/artifacts.json`;
const ADAPTER = "claude-agent-acp";

/** The prompt of a resumed session: the interrupted turn itself is not continued by the harness. */
const CONTINUE =
  "The platform restarted while you were working on this task, and your last turn was interrupted. " +
  "Check the state of the workspace, then continue the task where you left off and finish it.";

/** The prompt of a chat's session resumed after a restart interrupted its turn. */
const CHAT_CONTINUE =
  "The platform restarted while you were working on the operator's last message, and your turn was interrupted. " +
  "Check the state of the workspace, then continue where you left off and answer the operator.";

/** The volumes of a task's agent session, mounted into every sandbox it runs in. */
const volumesOf = (taskId: string): VolumeMount[] => [
  { volume: `${taskId}-workspace`, path: WORKSPACE },
  { volume: `${taskId}-session`, path: SESSION },
];

/** What a chat's session is told about the platform, after the profile's role description. */
const CHAT_INSTRUCTIONS = `You are in a chat with an operator of the Tendworks platform, who reads your answers and replies turn by turn; ask when you need something.
You work in a sandbox; your workspace is ${WORKSPACE}. Your credentials do not allow you to push, open pull requests or merge, so your work stays in the workspace.
When the operator does not answer for a while, the sandbox is removed and the session continues later in a new one, with the workspace and this conversation kept; processes you started in the background do not survive that.`;

/** What every unattended session is told about the platform, after the profile's role description. */
const PLATFORM_INSTRUCTIONS = `You work unattended in a sandbox; nobody answers questions during the session.
When you produce a result others need to find, such as a pull request, record it in ${ARTIFACTS} (also in $TENDWORKS_ARTIFACTS) as a JSON array of {"name": "<lowercase-name>", "url": "<absolute URL>", "description": "<optional>"}, e.g. [{"name": "pull-request", "url": "https://..."}]. Write the whole array each time.`;

/**
 * Harness `claude-code`: Claude Code through its ACP adapter
 * (`@agentclientprotocol/claude-agent-acp`), started over stdio in a sandbox created
 * from the profile's sandbox template. Before the session starts, the runtime checks out
 * the workspace the task asks for, copies the profile's skills into the harness's config
 * directory and passes the profile's secrets in; the role description is appended to the
 * harness's system prompt. Results the agent records in its artifacts file become
 * artifacts of the task. The sandbox is destroyed when the session ends.
 */
export function createClaudeCodeHarness({
  sandboxes,
  templates,
  credential,
  baseUrl,
  skills = new Map(),
  secrets = { resolve: () => undefined, problem: (name) => `secret ${name} is not set` },
  keepAliveMs = 60_000,
  timeoutMs = 60 * 60_000,
  platformMcp,
  cancelGraceMs = 10_000,
}: ClaudeCodeHarnessOptions): Harness {
  const failed = (message: string): HarnessResult => ({ state: "TASK_STATE_FAILED", message });

  /** Validation: what the task needs before anything is started; a failure names what is missing. */
  function validate(profile: LoadedAgentProfile): { template: SandboxTemplate; credential: ClaudeCodeCredential } | { failure: HarnessResult } {
    if (!credential) {
      return { failure: failed("no harness credential configured: set TEND_CLAUDE_CODE_CREDENTIAL to oauth-token or api-key and the matching variable in deploy/.env") };
    }
    const templateName = profile.spec.sandbox;
    const template = templateName === undefined ? undefined : templates(templateName);
    if (!template) return { failure: failed(`agent profile ${profile.metadata.name}: no sandbox template ${JSON.stringify(templateName ?? "")} is configured`) };
    const missingSkills = (profile.spec.skills ?? []).filter((name) => !skills.has(name));
    if (missingSkills.length > 0) return { failure: failed(`agent profile ${profile.metadata.name}: skills not configured: ${missingSkills.join(", ")}`) };
    return { template, credential };
  }

  /** Secrets: the profile's `spec.env`, resolved as agent secrets only. */
  function resolveSecrets(profile: LoadedAgentProfile): { env: Record<string, string> } | { failure: HarnessResult } {
    const env: Record<string, string> = {};
    const unresolved: string[] = [];
    for (const [variable, { secretRef }] of Object.entries(profile.spec.env ?? {})) {
      const value = secrets.resolve(secretRef.name);
      if (value) env[variable] = value;
      else unresolved.push(secrets.problem(secretRef.name) ?? `secret ${secretRef.name} is not set`);
    }
    if (unresolved.length > 0) return { failure: failed(`agent profile ${profile.metadata.name}: ${unresolved.join("; ")}`) };
    return { env };
  }

  /** MCP servers: the platform MCP server, configured for the session only when the profile lists it. */
  function mcpServersOf(profile: LoadedAgentProfile): { mcpServers: McpServers } | { failure: HarnessResult } {
    if (!profile.spec.mcp?.includes("tendworks")) return { mcpServers: [] };
    if (!platformMcp) {
      return { failure: failed(`agent profile ${profile.metadata.name} lists the platform MCP server, but none is configured: set TEND_PLATFORM_MCP_URL and TEND_API_READ_TOKEN for the worker`) };
    }
    return { mcpServers: [{ type: "http", name: "tendworks", url: platformMcp.url, headers: [{ name: "Authorization", value: `Bearer ${platformMcp.token}` }] }] };
  }

  /**
   * Volumes and sandbox: one pair of volumes per agent session (= task), named after the
   * task, mounted into a new sandbox. An interrupted session's sandbox is abandoned (its
   * adapter ended with the old worker's connection) and goes before the new one mounts
   * the same volumes.
   */
  async function startSandbox(
    taskId: string,
    template: SandboxTemplate,
    session: HarnessSession | undefined,
    observer: HarnessObserver,
  ): Promise<{ sandboxId: string; volumes: VolumeMount[] } | { failure: HarnessResult }> {
    const volumes = volumesOf(taskId);
    if (session?.sandboxId !== undefined) {
      observer.progress("removing the sandbox of the interrupted session");
      await sandboxes.destroy(session.sandboxId).catch(() => {});
    }
    observer.progress("starting a sandbox");
    try {
      return { sandboxId: (await sandboxes.create(template, { volumes })).id, volumes };
    } catch (error) {
      // The task fails for good, so volumes the backend may have created go too.
      await Promise.all(volumes.map(({ volume }) => sandboxes.deleteVolume(volume).catch(() => {})));
      return { failure: failed(`cannot create a sandbox from template ${template.metadata.name}: ${error instanceof Error ? error.message : String(error)}`) };
    }
  }

  /** Skills: the profile's skills, copied into the harness's config directory. */
  async function copySkills(sandboxId: string, profile: LoadedAgentProfile): Promise<void> {
    for (const name of profile.spec.skills ?? []) {
      for (const file of skills.get(name)!) await sandboxes.writeFile(sandboxId, `${CONFIG_DIR}/skills/${name}/${file.path}`, file.content);
    }
  }

  /** Checkout: the workspace the task asks for, with the profile's secrets (e.g. a repository token). */
  async function checkOut(
    sandboxId: string,
    workspace: Workspace,
    env: Record<string, string>,
    observer: HarnessObserver,
    redact: (text: string) => string,
  ): Promise<HarnessResult | undefined> {
    observer.progress(`checking out ${workspace.branch ?? workspace.repository}`);
    const checkout = await sandboxes.exec(sandboxId, { ...checkoutCommand(workspace), workingDirectory: WORKSPACE, env });
    observer.record({ type: "workspace-checkout", workspace, exitCode: checkout.exitCode, output: redact(checkout.stderr.trim()) });
    if (checkout.exitCode === 0) return undefined;
    const on = workspace.branch === undefined ? "" : ` on ${workspace.branch}`;
    return failed(redact(`cannot check out ${workspace.repository}${on}: ${checkout.stderr.trim().slice(-1_000)}`));
  }

  /** Adapter: the harness's ACP adapter started over stdio in the sandbox, with the profile's secrets and the one credential. */
  async function attachAdapter(sandboxId: string, env: Record<string, string>, credential: ClaudeCodeCredential): Promise<SandboxProcess> {
    return sandboxes.attach(sandboxId, {
      command: [ADAPTER],
      workingDirectory: WORKSPACE,
      env: {
        ...env,
        HOME,
        CLAUDE_CONFIG_DIR: CONFIG_DIR,
        DISABLE_AUTOUPDATER: "1", // versions are pinned in the image
        TENDWORKS_ARTIFACTS: ARTIFACTS,
        [CREDENTIAL_VARIABLES[credential.kind]]: credential.value,
        ...(baseUrl === undefined ? {} : { ANTHROPIC_BASE_URL: baseUrl }),
      },
    });
  }

  /** Preparation: validation, secrets and MCP servers, and how to redact secrets from what the harness writes. */
  function prepare(profile: LoadedAgentProfile): Prepared | { failure: HarnessResult } {
    const valid = validate(profile);
    if ("failure" in valid) return valid;
    const resolved = resolveSecrets(profile);
    if ("failure" in resolved) return resolved;
    const servers = mcpServersOf(profile);
    if ("failure" in servers) return servers;
    const hidden = [valid.credential.value, ...Object.values(resolved.env), platformMcp?.token ?? ""].filter((value) => value !== "");
    const redact = (text: string) => hidden.reduce((result, value) => result.replaceAll(value, "***"), text);
    return { ...valid, env: resolved.env, mcpServers: servers.mcpServers, redact };
  }

  /** ACP turn: the harness's ACP adapter over stdio, one prompt turn, resumed when the session was interrupted. */
  async function runTurn(
    { sandboxId, profile, message, session, env, credential, mcpServers, observer, redact }: {
      sandboxId: string;
      profile: LoadedAgentProfile;
      message: A2A.Message;
      session: HarnessSession | undefined;
      env: Record<string, string>;
      credential: ClaudeCodeCredential;
      mcpServers: McpServers;
      observer: HarnessObserver;
      redact: (text: string) => string;
    },
  ): Promise<AcpTurn> {
    const process = await attachAdapter(sandboxId, env, credential);
    observer.progress("harness started");
    const instructions = [profile.role, PLATFORM_INSTRUCTIONS].filter(Boolean).join("\n\n");
    return runAcpTurn({
      process,
      cwd: WORKSPACE,
      prompt: message.parts.flatMap(toContent),
      // The Claude Code adapter appends this to its own system prompt.
      sessionMeta: { systemPrompt: { append: instructions } },
      observer,
      redact,
      mcpServers,
      keepAliveMs,
      timeoutMs,
      onSession: (sessionId) => observer.saveSession({ sessionId, sandboxId }),
      ...(session?.sessionId === undefined ? {} : { resume: { sessionId: session.sessionId, prompt: [{ type: "text", text: CONTINUE }] } }),
    });
  }

  /** Artifact mapping: how the turn ended, with the artifacts the agent recorded when it finished. */
  async function toResult(turn: AcpTurn, sandboxId: string, taskId: string, observer: HarnessObserver, redact: (text: string) => string): Promise<HarnessResult> {
    if (turn.outcome === "error") return failed(redact(turn.error));
    const cost = turn.cost ? { cost: turn.cost } : {};
    switch (turn.stopReason) {
      case "end_turn": {
        const artifacts = await reportedArtifacts(sandboxes, sandboxId, taskId, (entry) => observer.record(entry));
        return { state: "TASK_STATE_COMPLETED", message: turn.reply, ...cost, ...(artifacts.length > 0 ? { artifacts } : {}) };
      }
      case "refusal":
        return { state: "TASK_STATE_REJECTED", message: turn.reply || "the agent refused the task", ...cost };
      case "cancelled":
        return { state: "TASK_STATE_CANCELED", message: turn.reply || "the session was cancelled", ...cost };
      case "max_tokens":
        return { state: "TASK_STATE_FAILED", message: `the agent stopped early: it reached its token limit${turn.reply ? `: ${turn.reply}` : ""}`, ...cost };
      case "max_turn_requests":
        return { state: "TASK_STATE_FAILED", message: `the agent stopped early: it reached its limit of model requests per turn${turn.reply ? `: ${turn.reply}` : ""}`, ...cost };
    }
  }

  return {
    async run({ taskId, profile, message, session }, observer) {
      const valid = prepare(profile);
      if ("failure" in valid) return valid.failure;
      const { env, mcpServers, redact } = valid;
      const requested = workspaceOf(message);
      if ("problem" in requested) return failed(requested.problem);

      const started = await startSandbox(taskId, valid.template, session, observer);
      if ("failure" in started) return started.failure;
      const { sandboxId, volumes } = started;
      try {
        // Kept at once, so a restart before the ACP session exists still finds this sandbox.
        await observer.saveSession({ ...session, sandboxId });
        await completeOnboarding(sandboxes, sandboxId, profile);
        await copySkills(sandboxId, profile);
        if (requested.workspace) {
          const checkoutFailure = await checkOut(sandboxId, requested.workspace, env, observer, redact);
          if (checkoutFailure) return checkoutFailure;
        }
        const turn = await runTurn({ sandboxId, profile, message, session, env, credential: valid.credential, mcpServers, observer, redact });
        return await toResult(turn, sandboxId, taskId, observer, redact);
      } catch (error) {
        return failed(redact(`the agent session failed: ${error instanceof Error ? error.message : String(error)}`));
      } finally {
        // Destroying the sandbox also ends background commands a cancel leaves running.
        // The session has ended, so its volumes go too; only an interrupted session keeps them.
        await sandboxes.destroy(sandboxId);
        await Promise.all(volumes.map(({ volume }) => sandboxes.deleteVolume(volume)));
      }
    },

    /**
     * A chat's agent session: the sandbox and the ACP adapter stay up between turns, so
     * each turn is one more prompt in the same ACP session. A session whose sandbox or
     * adapter is gone (e.g. after a restart) resumes on the kept volumes with the next
     * turn. The volumes go only when the session ends.
     */
    open({ taskId, profile, session, workspace }, observer) {
      let kept = session;
      let current: { sandboxId: string; acp: AcpSession } | undefined;
      const keep = async (next: HarnessSession) => {
        kept = next;
        await observer.saveSession(next);
      };

      /** The open ACP session, started (or resumed) in a new sandbox when there is none. */
      async function connect(prepared: Prepared) {
        if (current?.acp.open) return current;
        if (current) {
          // The adapter ended (or was given up after a cancel it did not answer); its sandbox cannot be reattached.
          await current.acp.close();
          current = undefined;
        }
        const started = await startSandbox(taskId, prepared.template, kept, observer);
        if ("failure" in started) return started;
        const { sandboxId } = started;
        await keep({ ...kept, sandboxId });
        await completeOnboarding(sandboxes, sandboxId, profile);
        await copySkills(sandboxId, profile);
        if (workspace) {
          // A workspace kept on its volume (e.g. after idle time) stays as it is.
          const checkoutFailure = await checkOut(sandboxId, workspace, prepared.env, observer, prepared.redact);
          if (checkoutFailure) {
            await sandboxes.destroy(sandboxId).catch(() => {});
            return { failure: checkoutFailure };
          }
        }
        const process = await attachAdapter(sandboxId, prepared.env, prepared.credential);
        observer.progress("harness started");
        const checkedOut = workspace ? `Your workspace is a checkout of ${workspace.repository}.` : "";
        const acp = await openAcpSession({
          process,
          cwd: WORKSPACE,
          sessionMeta: { systemPrompt: { append: [profile.role, CHAT_INSTRUCTIONS, checkedOut].filter(Boolean).join("\n\n") } },
          observer,
          redact: prepared.redact,
          mcpServers: prepared.mcpServers,
          keepAliveMs,
          cancelGraceMs,
          onSession: (sessionId) => keep({ sessionId, sandboxId }),
          ...(kept?.sessionId === undefined ? {} : { resume: { sessionId: kept.sessionId } }),
        });
        if ("outcome" in acp) {
          await sandboxes.destroy(sandboxId).catch(() => {});
          return { failure: failed(acp.error) };
        }
        current = { sandboxId, acp };
        return current;
      }

      /** Set when the running turn is cancelled before its prompt reached the agent. */
      let cancelled = false;

      return {
        async turn(message, { interrupted = false } = {}) {
          cancelled = false;
          const prepared = prepare(profile);
          if ("failure" in prepared) return { state: "TASK_STATE_FAILED", message: prepared.failure.message };
          try {
            const connected = await connect(prepared);
            if ("failure" in connected) return { state: "TASK_STATE_FAILED", message: connected.failure.message };
            if (cancelled) {
              observer.record({ type: "turn-ended", reason: "cancelled" });
              return { state: "TASK_STATE_INPUT_REQUIRED", message: answerOf("cancelled", "") };
            }
            // A resumed session holds the interrupted turn's message already; a new one gets it again.
            const prompt = interrupted && connected.acp.resumed ? [{ type: "text" as const, text: CHAT_CONTINUE }] : message.parts.flatMap(toContent);
            const turn = await connected.acp.prompt(prompt, { timeoutMs });
            if (turn.outcome === "error") return { state: "TASK_STATE_FAILED", message: turn.error };
            return { state: "TASK_STATE_INPUT_REQUIRED", message: answerOf(turn.stopReason, turn.reply), ...(turn.cost ? { cost: turn.cost } : {}) };
          } catch (error) {
            return { state: "TASK_STATE_FAILED", message: prepared.redact(`the agent session failed: ${error instanceof Error ? error.message : String(error)}`) };
          }
        },
        async cancel() {
          cancelled = true;
          await current?.acp.cancel();
        },
        async suspend() {
          // Taken at once, so a turn that starts meanwhile connects to a new sandbox.
          const suspended = current;
          const sandboxId = suspended?.sandboxId ?? kept?.sandboxId;
          current = undefined;
          if (sandboxId === undefined) return;
          await sandboxes.destroy(sandboxId).catch(() => {});
          await suspended?.acp.close();
          if (kept?.sandboxId === sandboxId) {
            const { sandboxId: _gone, ...rest } = kept;
            await keep(rest);
          }
        },
        async end() {
          // Destroying the sandbox first also ends a running turn and its background commands.
          const sandboxIds = new Set([current?.sandboxId, kept?.sandboxId].filter((id) => id !== undefined));
          for (const sandboxId of sandboxIds) await sandboxes.destroy(sandboxId).catch(() => {});
          await current?.acp.close();
          current = undefined;
          await Promise.all(volumesOf(taskId).map(({ volume }) => sandboxes.deleteVolume(volume)));
        },
      };
    },
  };
}

type McpServers = NonNullable<AcpSessionOptions["mcpServers"]>;

/** What a session needs before its sandbox starts. */
interface Prepared {
  template: SandboxTemplate;
  credential: ClaudeCodeCredential;
  env: Record<string, string>;
  mcpServers: McpServers;
  redact: (text: string) => string;
}

/** What the agent answered in a turn, or how the turn ended when it wrote nothing. */
function answerOf(stopReason: acp.StopReason, reply: string): string {
  if (reply) return reply;
  switch (stopReason) {
    case "end_turn":
      return "";
    case "refusal":
      return "the agent refused";
    case "cancelled":
      return "the turn was cancelled";
    case "max_tokens":
      return "the agent stopped early: it reached its token limit";
    case "max_turn_requests":
      return "the agent stopped early: it reached its limit of model requests per turn";
  }
}

/** The artifacts the agent recorded in its artifacts file; a malformed file is recorded and ignored. */
async function reportedArtifacts(
  sandboxes: Sandboxes,
  sandboxId: string,
  taskId: string,
  record: (entry: TranscriptRecord) => void,
): Promise<A2A.Artifact[]> {
  let text: string;
  try {
    text = new TextDecoder().decode(await sandboxes.readFile(sandboxId, ARTIFACTS));
  } catch (error) {
    if ((error as { code?: string }).code === "file-not-found") return [];
    throw error;
  }
  const parsed = parseReportedArtifacts(text);
  if ("problem" in parsed) {
    record({ type: "artifacts-ignored", problem: `${ARTIFACTS}: ${parsed.problem}` });
    return [];
  }
  record({ type: "artifacts", artifacts: parsed.artifacts });
  return parsed.artifacts.map((artifact) => toArtifact(taskId, artifact));
}

/**
 * A fresh Claude Code config ignores CLAUDE_CODE_OAUTH_TOKEN until onboarding is marked
 * complete (anthropics/claude-code#73403). Marks it in both places the global config may
 * live and lets the session use tools without asking; the sandbox is the boundary. A
 * profile with `attribution: false` turns Claude Code's AI attribution in commits and pull
 * requests off. Existing content is kept, except where the profile decides.
 */
async function completeOnboarding(sandboxes: Sandboxes, sandboxId: string, profile: LoadedAgentProfile): Promise<void> {
  const merge = async (path: string, change: (current: Record<string, unknown>) => Record<string, unknown>) => {
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(new TextDecoder().decode(await sandboxes.readFile(sandboxId, path))) as Record<string, unknown>;
    } catch (error) {
      if ((error as { code?: string }).code !== "file-not-found") throw error;
    }
    await sandboxes.writeFile(sandboxId, path, new TextEncoder().encode(JSON.stringify(change(current))));
  };
  const onboarded = (config: Record<string, unknown>) => ({ ...config, hasCompletedOnboarding: true });
  await merge(`${HOME}/.claude.json`, onboarded);
  await merge(`${CONFIG_DIR}/.claude.json`, onboarded);
  await merge(`${CONFIG_DIR}/settings.json`, (settings) => ({
    ...settings,
    permissions: { defaultMode: "bypassPermissions", ...(settings.permissions as Record<string, unknown> | undefined) },
    ...(profile.spec.attribution === false ? { attribution: { commit: "", pr: "", sessionUrl: false } } : {}),
  }));
}

function toContent(part: A2A.Part): acp.ContentBlock[] {
  if ("text" in part) return [{ type: "text", text: part.text }];
  if ("data" in part) return [{ type: "text", text: JSON.stringify(part.data, null, 2) }];
  if ("url" in part) return [{ type: "resource_link", uri: part.url, name: part.filename ?? part.url }];
  return [];
}
