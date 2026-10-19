import type * as acp from "@agentclientprotocol/sdk";
import type { A2A } from "@tendworks/shared";
import { runAcpTurn } from "../acp/acp-turn.js";
import { parseReportedArtifacts, toArtifact } from "../artifacts.js";
import type { Harness, HarnessResult } from "../harness.js";
import type { Sandboxes, SandboxTemplate } from "../sandboxes.js";
import type { SkillFile } from "../skills.js";
import { checkoutCommand, workspaceOf } from "../workspace.js";
import type { ClaudeCodeCredential } from "./credentials.js";

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
  /** Resolves a secret reference of a profile's `spec.env` (ADR 0008); undefined when it is not set. */
  secrets?: (name: string) => string | undefined;
  /** How often a quiet session is kept alive; below the socket proxy's 10-minute idle cut. */
  keepAliveMs?: number;
  /** How long one session may run before it is cancelled and the task fails. */
  timeoutMs?: number;
}

// Fixed paths inside the sandbox image (images/sandbox-claude-code). The harness's
// home and config directory live under /session so a volume can keep them later.
export const WORKSPACE = "/workspace";
const HOME = "/session/home";
const CONFIG_DIR = "/session/claude";
const ARTIFACTS = "/session/artifacts.json";
const ADAPTER = "claude-agent-acp";

const credentialVariables: Record<ClaudeCodeCredential["kind"], string> = {
  "oauth-token": "CLAUDE_CODE_OAUTH_TOKEN",
  "api-key": "ANTHROPIC_API_KEY",
};

/** What every session is told about the platform, after the profile's role description. */
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
  secrets = () => undefined,
  keepAliveMs = 60_000,
  timeoutMs = 60 * 60_000,
}: ClaudeCodeHarnessOptions): Harness {
  const failed = (message: string): HarnessResult => ({ state: "TASK_STATE_FAILED", message });

  return {
    async run({ taskId, profile, message }, observer) {
      if (!credential) {
        return failed("no harness credential configured: set TEND_CLAUDE_CODE_CREDENTIAL to oauth-token or api-key and the matching variable in deploy/.env");
      }
      const templateName = profile.spec.sandbox;
      const template = templateName === undefined ? undefined : templates(templateName);
      if (!template) return failed(`agent profile ${profile.metadata.name}: no sandbox template ${JSON.stringify(templateName ?? "")} is configured`);
      const missingSkills = (profile.spec.skills ?? []).filter((name) => !skills.has(name));
      if (missingSkills.length > 0) return failed(`agent profile ${profile.metadata.name}: skills not configured: ${missingSkills.join(", ")}`);
      const env: Record<string, string> = {};
      const unresolved: string[] = [];
      for (const [variable, { secretRef }] of Object.entries(profile.spec.env ?? {})) {
        const value = secrets(secretRef.name);
        if (value) env[variable] = value;
        else unresolved.push(secretRef.name);
      }
      if (unresolved.length > 0) return failed(`agent profile ${profile.metadata.name}: secret not set: ${unresolved.join(", ")}`);
      const requested = workspaceOf(message);
      if ("problem" in requested) return failed(requested.problem);

      const hidden = [credential.value, ...Object.values(env)].filter((value) => value !== "");
      const redact = (text: string) => hidden.reduce((result, value) => result.replaceAll(value, "***"), text);

      observer.progress("starting a sandbox");
      let sandboxId: string;
      try {
        sandboxId = (await sandboxes.create(template)).id;
      } catch (error) {
        return failed(`cannot create a sandbox from template ${template.metadata.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await completeOnboarding(sandboxes, sandboxId);
        for (const name of profile.spec.skills ?? []) {
          for (const file of skills.get(name)!) await sandboxes.writeFile(sandboxId, `${CONFIG_DIR}/skills/${name}/${file.path}`, file.content);
        }
        if (requested.workspace) {
          observer.progress(`checking out ${requested.workspace.branch}`);
          const checkout = await sandboxes.exec(sandboxId, { ...checkoutCommand(requested.workspace), workingDirectory: WORKSPACE, env });
          observer.record({ type: "workspace-checkout", workspace: requested.workspace, exitCode: checkout.exitCode, output: redact(checkout.stderr.trim()) });
          if (checkout.exitCode !== 0) {
            return failed(redact(`cannot check out ${requested.workspace.repository} on ${requested.workspace.branch}: ${checkout.stderr.trim().slice(-1_000)}`));
          }
        }
        const process = await sandboxes.attach(sandboxId, {
          command: [ADAPTER],
          workingDirectory: WORKSPACE,
          env: {
            ...env,
            HOME,
            CLAUDE_CONFIG_DIR: CONFIG_DIR,
            DISABLE_AUTOUPDATER: "1", // versions are pinned in the image
            TENDWORKS_ARTIFACTS: ARTIFACTS,
            [credentialVariables[credential.kind]]: credential.value,
            ...(baseUrl === undefined ? {} : { ANTHROPIC_BASE_URL: baseUrl }),
          },
        });
        observer.progress("harness started");
        const instructions = [profile.role, PLATFORM_INSTRUCTIONS].filter(Boolean).join("\n\n");
        const turn = await runAcpTurn({
          process,
          cwd: WORKSPACE,
          prompt: message.parts.flatMap(toContent),
          // The Claude Code adapter appends this to its own system prompt.
          sessionMeta: { systemPrompt: { append: instructions } },
          observer,
          redact,
          keepAliveMs,
          timeoutMs,
        });
        if (turn.outcome === "error") return failed(redact(turn.error));
        const cost = turn.cost ? { cost: turn.cost } : {};
        switch (turn.stopReason) {
          case "end_turn": {
            const artifacts = await reportedArtifacts(sandboxes, sandboxId, taskId, observer.record);
            return { state: "TASK_STATE_COMPLETED", message: turn.reply, ...cost, ...(artifacts.length > 0 ? { artifacts } : {}) };
          }
          case "refusal":
            return { state: "TASK_STATE_REJECTED", message: turn.reply || "the agent refused the task", ...cost };
          case "cancelled":
            return { state: "TASK_STATE_CANCELED", message: turn.reply || "the session was cancelled", ...cost };
          default:
            return { state: "TASK_STATE_FAILED", message: `the agent stopped early (${turn.stopReason})${turn.reply ? `: ${turn.reply}` : ""}`, ...cost };
        }
      } catch (error) {
        return failed(redact(`the agent session failed: ${error instanceof Error ? error.message : String(error)}`));
      } finally {
        // Destroying the sandbox also ends background commands a cancel leaves running.
        await sandboxes.destroy(sandboxId);
      }
    },
  };
}

/** The artifacts the agent recorded in its artifacts file; a malformed file is recorded and ignored. */
async function reportedArtifacts(
  sandboxes: Sandboxes,
  sandboxId: string,
  taskId: string,
  record: (entry: { type: string; [key: string]: unknown }) => void,
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
    record({ type: "artifacts-ignored", file: ARTIFACTS, problem: parsed.problem });
    return [];
  }
  record({ type: "artifacts", artifacts: parsed.artifacts });
  return parsed.artifacts.map((artifact) => toArtifact(taskId, artifact));
}

/**
 * A fresh Claude Code config ignores CLAUDE_CODE_OAUTH_TOKEN until onboarding is marked
 * complete (anthropics/claude-code#73403). Marks it in both places the global config may
 * live and lets the session use tools without asking; the sandbox is the boundary.
 * Existing content is kept.
 */
async function completeOnboarding(sandboxes: Sandboxes, sandboxId: string): Promise<void> {
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
  }));
}

function toContent(part: A2A.Part): acp.ContentBlock[] {
  if ("text" in part) return [{ type: "text", text: part.text }];
  if ("data" in part) return [{ type: "text", text: JSON.stringify(part.data, null, 2) }];
  if ("url" in part) return [{ type: "resource_link", uri: part.url, name: part.filename ?? part.url }];
  return [];
}
