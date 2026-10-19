import type * as acp from "@agentclientprotocol/sdk";
import type { A2A } from "@tendworks/shared";
import { runAcpTurn } from "../acp/acp-turn.js";
import type { Harness, HarnessResult } from "../harness.js";
import type { Sandboxes, SandboxTemplate } from "../sandboxes.js";
import type { ClaudeCodeCredential } from "./credentials.js";

export interface ClaudeCodeHarnessOptions {
  sandboxes: Sandboxes;
  /** Looks up a sandbox template by name. */
  templates: (name: string) => SandboxTemplate | undefined;
  /** The one credential passed into the sandbox; undefined fails every task with a hint. */
  credential: ClaudeCodeCredential | undefined;
  /** Alternative model endpoint (`ANTHROPIC_BASE_URL`), e.g. a gateway. */
  baseUrl?: string;
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
const ADAPTER = "claude-agent-acp";

const credentialVariables: Record<ClaudeCodeCredential["kind"], string> = {
  "oauth-token": "CLAUDE_CODE_OAUTH_TOKEN",
  "api-key": "ANTHROPIC_API_KEY",
};

/**
 * Harness `claude-code`: Claude Code through its ACP adapter
 * (`@agentclientprotocol/claude-agent-acp`), started over stdio in a sandbox created
 * from the profile's sandbox template. The sandbox is destroyed when the session ends.
 */
export function createClaudeCodeHarness({
  sandboxes,
  templates,
  credential,
  baseUrl,
  keepAliveMs = 60_000,
  timeoutMs = 60 * 60_000,
}: ClaudeCodeHarnessOptions): Harness {
  const failed = (message: string): HarnessResult => ({ state: "TASK_STATE_FAILED", message });
  const redact = (text: string) => (credential && credential.value !== "" ? text.replaceAll(credential.value, "***") : text);

  return {
    async run({ profile, message }, observer) {
      if (!credential) {
        return failed("no harness credential configured: set TEND_CLAUDE_CODE_CREDENTIAL to oauth-token or api-key and the matching variable in deploy/.env");
      }
      const templateName = profile.spec.sandbox;
      const template = templateName === undefined ? undefined : templates(templateName);
      if (!template) return failed(`agent profile ${profile.metadata.name}: no sandbox template ${JSON.stringify(templateName ?? "")} is configured`);

      observer.progress("starting a sandbox");
      let sandboxId: string;
      try {
        sandboxId = (await sandboxes.create(template)).id;
      } catch (error) {
        return failed(`cannot create a sandbox from template ${template.metadata.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await completeOnboarding(sandboxes, sandboxId);
        const process = await sandboxes.attach(sandboxId, {
          command: [ADAPTER],
          workingDirectory: WORKSPACE,
          env: {
            HOME,
            CLAUDE_CONFIG_DIR: CONFIG_DIR,
            DISABLE_AUTOUPDATER: "1", // versions are pinned in the image
            [credentialVariables[credential.kind]]: credential.value,
            ...(baseUrl === undefined ? {} : { ANTHROPIC_BASE_URL: baseUrl }),
          },
        });
        observer.progress("harness started");
        const turn = await runAcpTurn({
          process,
          cwd: WORKSPACE,
          prompt: message.parts.flatMap(toContent),
          observer,
          redact,
          keepAliveMs,
          timeoutMs,
        });
        if (turn.outcome === "error") return failed(redact(turn.error));
        const cost = turn.cost ? { cost: turn.cost } : {};
        switch (turn.stopReason) {
          case "end_turn":
            return { state: "TASK_STATE_COMPLETED", message: turn.reply, ...cost };
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
