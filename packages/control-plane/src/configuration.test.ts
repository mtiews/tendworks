import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigurationError, loadConfiguration } from "./index.js";

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tend-config-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const workflow = (name: string, agent = "developer") => `
document: { dsl: '1.0.3', namespace: test, name: ${name}, version: '0.1.0' }
do:
  - implement:
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://${agent} }
        parameters:
          message:
            parts: [{ kind: text, text: build it }]
`;

const agent = (name: string, spec = "harness: fake") =>
  `---\napiVersion: tendworks.dev/v1\nkind: AgentProfile\nmetadata:\n  name: ${name}\nspec:\n  ${spec}\n---\nRole description.\n`;

const trigger = (name: string, workflowName: string, kind = "schedule: { every: { minutes: 5 } }", extra = "") => `
apiVersion: tendworks.dev/v1
kind: TriggerBinding
metadata: { name: ${name} }
spec:
  workflow: ${workflowName}
  trigger:
    ${kind}
  ${extra}
`;

const workspace = (name: string, extra = "") => `
apiVersion: tendworks.dev/v1
kind: Workspace
metadata: { name: ${name} }
spec:
  git: { url: https://git.example/acme/${name}.git, defaultBranch: main }
  ${extra}
`;

function issuesOf(dir: string): string[] {
  try {
    loadConfiguration(dir);
  } catch (error) {
    if (error instanceof ConfigurationError) return error.issues;
    throw error;
  }
  throw new Error("expected the configuration to be rejected");
}

describe("loadConfiguration", () => {
  it("loads workflows by name and agent profiles", () => {
    const dir = folder({
      "workflows/build.sw.yaml": workflow("build"),
      "agents/developer.md": agent("developer"),
      "sandboxes/node.yaml": "apiVersion: tendworks.dev/v1\nkind: SandboxTemplate\nmetadata:\n  name: node\nspec:\n  image: node:24.21.0-trixie-slim\n",
    });

    const configuration = loadConfiguration(dir);

    expect(configuration.workflow("build")).toMatchObject({ document: { name: "build" } });
    expect(configuration.workflow("nope")).toBeUndefined();
    expect(configuration.workflowNames).toEqual(["build"]);
    expect(configuration.agentProfiles.map((profile) => profile.metadata.name)).toEqual(["developer"]);
  });

  it("names the file and field of every invalid document", () => {
    const dir = folder({
      "workflows/build.sw.yaml": workflow("build").replace("method: message/send", "method: message/stream"),
      "agents/developer.md": agent("developer", "harness: magic"),
      "sandboxes/node.yaml": "apiVersion: tendworks.dev/v1\nkind: SandboxTemplate\nmetadata:\n  name: node\nspec: {}\n",
    });

    expect(issuesOf(dir)).toEqual([
      "agents/developer.md: /spec/harness: must be equal to one of the allowed values (fake, claude-code)",
      "sandboxes/node.yaml: /spec: must have required property 'image'",
      "workflows/build.sw.yaml: /do/0/implement/with/method: must be 'message/send'",
    ]);
  });

  it("rejects unknown kinds, unreadable YAML and missing frontmatter", () => {
    const dir = folder({
      "triggers/x.yaml": "apiVersion: tendworks.dev/v1\nkind: Gizmo\nmetadata: { name: x }\nspec: {}\n",
      "workflows/broken.sw.yaml": "document: [",
      "agents/plain.md": "no frontmatter\n",
    });

    const issues = issuesOf(dir);

    expect(issues[0]).toBe("agents/plain.md: missing YAML frontmatter");
    expect(issues[1]).toBe("triggers/x.yaml: unknown kind 'Gizmo' (known: AgentProfile, NotificationChannel, Policy, SandboxTemplate, Subscription, TriggerBinding, Workspace)");
    expect(issues[2]).toMatch(/^workflows\/broken\.sw\.yaml: invalid YAML: /);
  });

  it("rejects a workflow that calls an agent profile that is not configured", () => {
    const dir = folder({ "workflows/build.sw.yaml": workflow("build", "ghost"), "agents/developer.md": agent("developer") });

    expect(issuesOf(dir)).toEqual(["workflows/build.sw.yaml: /do/0/implement calls agent://ghost, but no agent profile 'ghost' is configured"]);
  });

  it("rejects two workflows with the same name", () => {
    const dir = folder({
      "workflows/a.sw.yaml": workflow("build"),
      "workflows/b.sw.yaml": workflow("build"),
      "agents/developer.md": agent("developer"),
    });

    expect(issuesOf(dir)).toEqual(["workflows/b.sw.yaml: workflow 'build' is already defined in workflows/a.sw.yaml"]);
  });

  it("loads trigger bindings", () => {
    const dir = folder({
      "workflows/build.sw.yaml": workflow("build"),
      "agents/developer.md": agent("developer"),
      "triggers/ready.yaml": trigger("ready", "build"),
      "triggers/nightly.yaml": trigger("nightly", "build", "schedule: { cron: '0 2 * * *' }", "workspaces: [app]"),
      "triggers/review.yaml": trigger("review", "build", "manual: {}", "workspaces: [app]"),
      "workspaces/app.yaml": workspace("app"),
    });

    const configuration = loadConfiguration(dir);

    expect(configuration.triggerBindings).toEqual([
      {
        apiVersion: "tendworks.dev/v1",
        kind: "TriggerBinding",
        metadata: { name: "nightly" },
        spec: { workflow: "build", trigger: { schedule: { cron: "0 2 * * *" } }, workspaces: ["app"] },
      },
      {
        apiVersion: "tendworks.dev/v1",
        kind: "TriggerBinding",
        metadata: { name: "ready" },
        spec: { workflow: "build", trigger: { schedule: { every: { minutes: 5 } } } },
      },
      {
        apiVersion: "tendworks.dev/v1",
        kind: "TriggerBinding",
        metadata: { name: "review" },
        spec: { workflow: "build", trigger: { manual: {} }, workspaces: ["app"] },
      },
    ]);
  });

  it("rejects an invalid trigger binding, one bound to an unknown workflow, and duplicates", () => {
    const dir = folder({
      "workflows/build.sw.yaml": workflow("build"),
      "agents/developer.md": agent("developer"),
      "triggers/a.yaml": trigger("ready", "build"),
      "triggers/b.yaml": trigger("ready", "build"),
      "triggers/c.yaml": trigger("ghostly", "ghost"),
      "triggers/d.yaml": trigger("broken", "build", "github-issues: { labels: [ready], every: { fortnights: 1 }, token: { secretRef: { name: TENDWORKS_PLATFORM_GITHUB_TOKEN } } }"),
      "triggers/e.yaml": trigger("twice", "build", "schedule: { every: { minutes: 5 } }\n    github-issues: { labels: [ready], every: { minutes: 5 }, token: { secretRef: { name: TENDWORKS_PLATFORM_GITHUB_TOKEN } } }"),
      "triggers/f.yaml": trigger("unknown", "build", "webhook: { path: /hook }"),
      "triggers/g.yaml": trigger("faked", "build", "fake: { every: { minutes: 5 } }"),
      "triggers/h.yaml": trigger("manually", "build", "manual: { every: { minutes: 5 } }"),
    });

    expect(issuesOf(dir)).toEqual([
      "triggers/b.yaml: trigger binding 'ready' is already defined in triggers/a.yaml",
      "triggers/d.yaml: /spec/trigger/github-issues/every: unsupported property 'fortnights'",
      "triggers/e.yaml: /spec/trigger: must NOT have more than 1 properties",
      "triggers/f.yaml: /spec/trigger: unsupported property 'webhook'",
      // The test-only kind fake is not deployed with the platform.
      "triggers/g.yaml: /spec/trigger: unsupported property 'fake'",
      "triggers/h.yaml: /spec/trigger/manual: unsupported property 'every'",
      "triggers/c.yaml: trigger binding 'ghostly' starts workflow 'ghost', but no workflow 'ghost' is configured",
    ]);
  });

  it("accepts a github-issues trigger only with its token as a secret reference", () => {
    const github = (name: string, token: string) =>
      trigger(name, "build", `github-issues: { labels: [ready-for-agent], every: { minutes: 1 }${token} }`, "workspaces: [app]");
    const valid = folder({
      "workflows/build.sw.yaml": workflow("build"),
      "agents/developer.md": agent("developer"),
      "triggers/github.yaml": github("github", ", token: { secretRef: { name: TENDWORKS_PLATFORM_GITHUB_TOKEN } }"),
      "workspaces/app.yaml": workspace("app"),
    });
    expect(loadConfiguration(valid).triggerBindings[0]?.spec.trigger).toEqual({
      "github-issues": { labels: ["ready-for-agent"], every: { minutes: 1 }, token: { secretRef: { name: "TENDWORKS_PLATFORM_GITHUB_TOKEN" } } },
    });

    const invalid = folder({
      "workflows/build.sw.yaml": workflow("build"),
      "agents/developer.md": agent("developer"),
      "triggers/a.yaml": github("a", ""),
      "triggers/b.yaml": github("b", ", token: github_pat_plaintext"),
      "workspaces/app.yaml": workspace("app"),
    });
    expect(issuesOf(invalid)).toEqual([
      "triggers/a.yaml: /spec/trigger/github-issues: must have required property 'token'",
      "triggers/b.yaml: /spec/trigger/github-issues/token: must be object",
    ]);
  });

  it("lets agent profiles reference only agent secrets and trigger bindings only platform secrets", () => {
    const github = (secret: string) =>
      trigger("github", "build", `github-issues: { every: { minutes: 1 }, token: { secretRef: { name: ${secret} } } }`);
    const dir = folder({
      "workflows/build.sw.yaml": workflow("build"),
      "agents/developer.md": agent("developer", "harness: fake\n  env: { GH_TOKEN: { secretRef: { name: TENDWORKS_PLATFORM_GITHUB_TOKEN } } }"),
      "triggers/github.yaml": github("TENDWORKS_AGENT_PLAYGROUND_TOKEN"),
    });

    expect(issuesOf(dir)).toEqual([
      `agents/developer.md: /spec/env/GH_TOKEN/secretRef/name: must match pattern "^TENDWORKS_AGENT_[A-Z0-9_]+$"`,
      `triggers/github.yaml: /spec/trigger/github-issues/token/secretRef/name: must match pattern "^TENDWORKS_PLATFORM_[A-Z0-9_]+$"`,
      "workflows/build.sw.yaml: /do/0/implement calls agent://developer, but no agent profile 'developer' is configured",
    ]);
  });

  it("loads policies per action and rejects invalid ones and duplicates", () => {
    const policy = (name: string, actions: string) => `apiVersion: tendworks.dev/v1\nkind: Policy\nmetadata: { name: ${name} }\nspec: { actions: ${actions} }\n`;
    const valid = folder({ "policies/trusted.yaml": policy("trusted", "{ deploy: allow }"), "policies/careful.yaml": policy("careful", "{ deploy: ask, merge-pull-request: ask }") });
    expect(loadConfiguration(valid).policies.map((p) => [p.metadata.name, p.spec.actions])).toEqual([
      ["careful", { deploy: "ask", "merge-pull-request": "ask" }],
      ["trusted", { deploy: "allow" }],
    ]);

    const invalid = folder({
      "policies/a.yaml": policy("trusted", "{ deploy: allow }"),
      "policies/b.yaml": policy("trusted", "{ deploy: ask }"),
      "policies/c.yaml": policy("sloppy", "{ deploy: always }"),
      "policies/d.yaml": policy("empty", "{}"),
    });
    expect(issuesOf(invalid)).toEqual([
      "policies/b.yaml: policy 'trusted' is already defined in policies/a.yaml",
      "policies/c.yaml: /spec/actions/deploy: must be equal to one of the allowed values (allow, ask)",
      "policies/d.yaml: /spec/actions: must NOT have fewer than 1 properties",
    ]);
  });

  it("loads notification channels, which hold only how someone is reached, ordered by name", () => {
    const dir = folder({
      "notifications/phone.yaml": `apiVersion: tendworks.dev/v1
kind: NotificationChannel
metadata: { name: phone }
spec:
  integration: pushover
  priority: 1
  pushover:
    token: { secretRef: { name: TENDWORKS_PLATFORM_PUSHOVER_TOKEN } }
    user: { secretRef: { name: TENDWORKS_PLATFORM_PUSHOVER_USER } }
`,
      "notifications/log.yaml": "apiVersion: tendworks.dev/v1\nkind: NotificationChannel\nmetadata: { name: log }\nspec: { integration: fake }\n",
    });

    expect(loadConfiguration(dir).notificationChannels.map(({ metadata, spec }) => [metadata.name, spec])).toEqual([
      ["log", { integration: "fake" }],
      [
        "phone",
        {
          integration: "pushover",
          priority: 1,
          pushover: {
            token: { secretRef: { name: "TENDWORKS_PLATFORM_PUSHOVER_TOKEN" } },
            user: { secretRef: { name: "TENDWORKS_PLATFORM_PUSHOVER_USER" } },
          },
        },
      ],
    ]);
  });

  it("rejects a notification channel without its settings, with plain or agent secrets, events of its own, a priority out of range and duplicates", () => {
    const channel = (name: string, spec: string) => `apiVersion: tendworks.dev/v1\nkind: NotificationChannel\nmetadata: { name: ${name} }\nspec: ${spec}\n`;
    const dir = folder({
      "notifications/a.yaml": channel("log", "{ integration: fake }"),
      "notifications/b.yaml": channel("log", "{ integration: fake }"),
      "notifications/c.yaml": channel("bare", "{ integration: pushover }"),
      "notifications/d.yaml": channel(
        "leaky",
        "{ integration: pushover, pushover: { token: plaintext, user: { secretRef: { name: TENDWORKS_AGENT_PUSHOVER_USER } } } }",
      ),
      "notifications/e.yaml": channel("selective", "{ integration: fake, events: [run.completed] }"),
      "notifications/f.yaml": channel(
        "emergency",
        "{ integration: pushover, priority: 2, pushover: { token: { secretRef: { name: TENDWORKS_PLATFORM_PUSHOVER_TOKEN } }, user: { secretRef: { name: TENDWORKS_PLATFORM_PUSHOVER_USER } } } }",
      ),
    });

    expect(issuesOf(dir)).toEqual([
      "notifications/b.yaml: notification channel 'log' is already defined in notifications/a.yaml",
      "notifications/c.yaml: /spec: must have required property 'pushover'",
      "notifications/d.yaml: /spec/pushover/token: must be object",
      `notifications/d.yaml: /spec/pushover/user/secretRef/name: must match pattern "^TENDWORKS_PLATFORM_[A-Z0-9_]+$"`,
      "notifications/e.yaml: /spec: unsupported property 'events'",
      "notifications/f.yaml: /spec/priority: must be <= 1",
    ]);
  });

  describe("subscriptions", () => {
    const subscription = (name: string, spec: string) => `apiVersion: tendworks.dev/v1\nkind: Subscription\nmetadata: { name: ${name} }\nspec: ${spec}\n`;
    const workspace = (name: string) => `apiVersion: tendworks.dev/v1\nkind: Workspace\nmetadata: { name: ${name} }\nspec: { git: { url: "https://git.example/acme/${name}.git", defaultBranch: main } }\n`;
    const channel = (name: string) => `apiVersion: tendworks.dev/v1\nkind: NotificationChannel\nmetadata: { name: ${name} }\nspec: { integration: fake }\n`;
    const base = { "workspaces/app.yaml": workspace("app"), "notifications/phone.yaml": channel("phone"), "notifications/log.yaml": channel("log") };

    it("loads subscriptions of a workspace and of the platform, ordered by name", () => {
      const dir = folder({
        ...base,
        "projects/app/subscriptions.yaml": subscription("app-failures", "{ scope: { workspace: app }, events: [run.failed, approval.requested], channels: [phone, log], priority: 1 }"),
        "platform/subscriptions/health.yaml": subscription("a-platform", "{ scope: { platform: {} }, events: [platform.degraded, platform.recovered, run.completed], channels: [phone] }"),
      });

      expect(loadConfiguration(dir).subscriptions.map(({ metadata, spec }) => [metadata.name, spec])).toEqual([
        ["a-platform", { scope: { platform: {} }, events: ["platform.degraded", "platform.recovered", "run.completed"], channels: ["phone"] }],
        ["app-failures", { scope: { workspace: "app" }, events: ["run.failed", "approval.requested"], channels: ["phone", "log"], priority: 1 }],
      ]);
    });

    it("refuses an unknown workspace or channel, an event outside the scope, empty lists, both or no scope, a priority out of range and duplicates", () => {
      const dir = folder({
        ...base,
        "s/a.yaml": subscription("dup", "{ scope: { workspace: app }, events: [run.failed], channels: [phone] }"),
        "s/b.yaml": subscription("dup", "{ scope: { workspace: app }, events: [run.failed], channels: [phone] }"),
        "s/c.yaml": subscription("lost", "{ scope: { workspace: nowhere }, events: [run.failed], channels: [phone] }"),
        "s/d.yaml": subscription("mute", "{ scope: { workspace: app }, events: [run.failed], channels: [pager] }"),
        "s/e.yaml": subscription("health-in-project", "{ scope: { workspace: app }, events: [platform.degraded], channels: [phone] }"),
        "s/f.yaml": subscription("no-events", "{ scope: { workspace: app }, events: [], channels: [phone] }"),
        "s/g.yaml": subscription("no-channels", "{ scope: { workspace: app }, events: [run.failed], channels: [] }"),
        "s/h.yaml": subscription("both", "{ scope: { workspace: app, platform: {} }, events: [run.failed], channels: [phone] }"),
        "s/i.yaml": subscription("neither", "{ scope: {}, events: [run.failed], channels: [phone] }"),
        "s/j.yaml": subscription("unknown-event", "{ scope: { platform: {} }, events: [step.started], channels: [phone] }"),
        "s/k.yaml": subscription("emergency", "{ scope: { platform: {} }, events: [platform.degraded], channels: [phone], priority: 2 }"),
      });

      const issues = issuesOf(dir);
      expect(issues).toContain("s/b.yaml: subscription 'dup' is already defined in s/a.yaml");
      expect(issues).toContain("s/c.yaml: subscription 'lost' is for workspace 'nowhere', but no workspace 'nowhere' is configured");
      expect(issues).toContain("s/d.yaml: subscription 'mute' sends to channel 'pager', but no notification channel 'pager' is configured");
      expect(issues).toContain(
        "s/e.yaml: subscription 'health-in-project' selects event 'platform.degraded', which the workspace scope does not have (it has: run.started, run.completed, run.failed, approval.requested)",
      );
      expect(issues).toContain("s/f.yaml: /spec/events: must NOT have fewer than 1 items");
      expect(issues).toContain("s/g.yaml: /spec/channels: must NOT have fewer than 1 items");
      expect(issues.filter((issue) => issue.startsWith("s/h.yaml"))).not.toEqual([]);
      expect(issues.filter((issue) => issue.startsWith("s/i.yaml"))).not.toEqual([]);
      expect(issues.some((issue) => issue.startsWith("s/j.yaml: /spec/events/0: must be equal to one of the allowed values"))).toBe(true);
      expect(issues).toContain("s/k.yaml: /spec/priority: must be <= 1");
    });
  });

  it("rejects a policy for a workflow that is not configured, so a typo cannot loosen a human step", () => {
    const dir = folder({
      "workflows/build.sw.yaml": workflow("build"),
      "agents/developer.md": agent("developer"),
      "policies/careful.yaml": "apiVersion: tendworks.dev/v1\nkind: Policy\nmetadata: { name: careful }\nspec: { actions: { deploy: allow }, workflows: [build, biuld] }\n",
    });

    expect(issuesOf(dir)).toEqual(["policies/careful.yaml: policy 'careful' names workflow 'biuld', which is not configured (configured: build)"]);
  });

  it("accepts http calls in workflows without asking for agent profiles", () => {
    const dir = folder({
      "workflows/notify.sw.yaml": `
document: { dsl: '1.0.3', namespace: test, name: notify, version: '0.1.0' }
do:
  - notify:
      call: http
      with: { method: get, endpoint: '\${ $runtime.metadata.controlPlaneUrl + "/status" }' }
`,
    });

    expect(loadConfiguration(dir).workflowNames).toEqual(["notify"]);
  });

  it("loads git workspaces with their credentials", () => {
    const dir = folder({
      "workspaces/app.yaml": workspace("app", "credentials: { secretRef: { name: TENDWORKS_AGENT_APP_TOKEN }, env: GH_TOKEN }"),
      "workspaces/docs.yaml": workspace("docs"),
    });

    expect(loadConfiguration(dir).workspaces).toEqual([
      {
        apiVersion: "tendworks.dev/v1",
        kind: "Workspace",
        metadata: { name: "app" },
        spec: { git: { url: "https://git.example/acme/app.git", defaultBranch: "main" }, credentials: { secretRef: { name: "TENDWORKS_AGENT_APP_TOKEN" }, env: "GH_TOKEN" } },
      },
      { apiVersion: "tendworks.dev/v1", kind: "Workspace", metadata: { name: "docs" }, spec: { git: { url: "https://git.example/acme/docs.git", defaultBranch: "main" } } },
    ]);
  });

  it("rejects a workspace with credentials in its URL, a platform secret as credential, and duplicates", () => {
    const dir = folder({
      "workspaces/a.yaml": workspace("app"),
      "workspaces/b.yaml": workspace("app"),
      "workspaces/c.yaml": workspace("leaky").replace("https://git.example", "https://user:pass@git.example"),
      "workspaces/d.yaml": workspace("platform", "credentials: { secretRef: { name: TENDWORKS_PLATFORM_GITHUB_TOKEN } }"),
    });

    expect(issuesOf(dir)).toEqual([
      "workspaces/b.yaml: workspace 'app' is already defined in workspaces/a.yaml",
      expect.stringMatching(/^workspaces\/c\.yaml: \/spec\/git\/url: must match pattern/),
      `workspaces/d.yaml: /spec/credentials/secretRef/name: must match pattern "^TENDWORKS_AGENT_[A-Z0-9_]+$"`,
    ]);
  });

  it("refuses credentials for a git workspace whose URL is not https, and accepts http and file URLs without them", () => {
    const keyed = "credentials: { secretRef: { name: TENDWORKS_AGENT_APP_TOKEN } }";
    const dir = folder({
      "workspaces/plain.yaml": workspace("plain", keyed).replace("https://", "http://"),
      "workspaces/local.yaml": workspace("local", keyed).replace("https://git.example/acme/local.git", "file:///srv/repos/local.git"),
      "workspaces/public.yaml": workspace("public").replace("https://", "http://"),
      "workspaces/bundled.yaml": workspace("bundled").replace("https://git.example/acme/bundled.git", "file:///srv/repos/bundled.git"),
    });

    expect(issuesOf(dir)).toEqual([
      "workspaces/local.yaml: workspace 'local': credentials need an https:// URL, but git.url is file:///srv/repos/local.git; the credential would leave the sandbox unencrypted or go nowhere",
      "workspaces/plain.yaml: workspace 'plain': credentials need an https:// URL, but git.url is http://git.example/acme/plain.git; the credential would leave the sandbox unencrypted or go nowhere",
    ]);
  });

  it("loads directory workspaces under a workspace root and refuses those outside, also through '..' or a symbolic link", () => {
    const host = realpathSync.native(mkdtempSync(join(tmpdir(), "tend-host-")));
    const root = join(host, "root");
    mkdirSync(join(root, "app"), { recursive: true });
    mkdirSync(join(host, "outside"));
    symlinkSync(join(host, "outside"), join(root, "escape"), "junction");
    const directory = (name: string, path: string) =>
      `apiVersion: tendworks.dev/v1\nkind: Workspace\nmetadata: { name: ${name} }\nspec:\n  directory: { path: ${JSON.stringify(path)} }\n`;
    const files = {
      "workspaces/app.yaml": directory("app", join(root, "app")),
      "workspaces/dots.yaml": directory("dots", `${join(root, "app")}/../../outside`),
      "workspaces/escape.yaml": directory("escape", join(root, "escape")),
      "workspaces/keyed.yaml": `${directory("keyed", join(root, "app"))}  credentials: { secretRef: { name: TENDWORKS_AGENT_APP_TOKEN } }\n`,
    };

    let issues: string[] = [];
    try {
      loadConfiguration(folder(files), { workspaceRoots: [root] });
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      issues = error.issues;
    }
    expect(issues).toEqual([
      expect.stringMatching(/^workspaces\/dots\.yaml: workspace 'dots': directory .* is not under a workspace root/),
      expect.stringMatching(/^workspaces\/escape\.yaml: workspace 'escape': directory .* is not under a workspace root/),
      "workspaces/keyed.yaml: /spec/credentials: is not allowed here",
    ]);
    const { "workspaces/app.yaml": app } = files;
    expect(loadConfiguration(folder({ "workspaces/app.yaml": app }), { workspaceRoots: [root] }).workspaces).toEqual([
      { apiVersion: "tendworks.dev/v1", kind: "Workspace", metadata: { name: "app" }, spec: { directory: { path: join(root, "app") } } },
    ]);
    expect(issuesOf(folder({ "workspaces/app.yaml": app }))).toEqual([expect.stringContaining("TEND_WORKSPACE_ROOTS allows no directory workspaces")]);
  });

  it("refuses a workflow or trigger binding that names a workspace that is not configured", () => {
    const dir = folder({
      "workflows/build.sw.yaml": workflow("build").replace("parts: [{ kind: text, text: build it }]", "parts: [{ kind: text, text: build it }]\n            metadata: { dev.tendworks/workspace: { name: ghost } }"),
      "workflows/scan.sw.yaml": workflow("scan").replace("parts: [{ kind: text, text: build it }]", "parts: [{ kind: text, text: scan it }]\n            metadata: { dev.tendworks/workspace: { name: '${ .workspace }' } }"),
      "agents/developer.md": agent("developer"),
      "triggers/scan.yaml": trigger("scan", "scan", undefined, "workspaces: [app, phantom]"),
      "triggers/app.yaml": trigger("app", "scan", undefined, "workspaces: [app]"),
      "workspaces/app.yaml": workspace("app"),
    });

    expect(issuesOf(dir)).toEqual([
      "workflows/build.sw.yaml: /do/0/implement works in workspace 'ghost', but no workspace 'ghost' is configured",
      "triggers/scan.yaml: trigger binding 'scan' starts runs in workspace 'phantom', but no workspace 'phantom' is configured",
    ]);
  });

  it("refuses a workspace whose enabled assistant's profile is not configured or allows no chats", () => {
    const dir = folder({
      "agents/workspace-assistant.md": agent("workspace-assistant", "harness: fake\n  chat: {}"),
      "agents/developer.md": agent("developer"),
      "workspaces/app.yaml": workspace("app", "assistant: { enabled: true }"),
      "workspaces/docs.yaml": workspace("docs", "assistant: { enabled: true, profile: developer, write: true }"),
      "workspaces/site.yaml": workspace("site", "assistant: { enabled: true, profile: ghost }"),
      "workspaces/off.yaml": workspace("off", "assistant: { enabled: false, profile: ghost }"),
    });

    expect(issuesOf(dir)).toEqual([
      "workspaces/docs.yaml: workspace 'docs' has its assistant held with agent profile 'developer', which allows no chats (spec.chat)",
      "workspaces/site.yaml: workspace 'site' has its assistant held with agent profile 'ghost', but no agent profile 'ghost' is configured",
    ]);
  });

  it("rejects a folder that does not exist", () => {
    expect(() => loadConfiguration(join(tmpdir(), "tend-config-missing"))).toThrow(/cannot read configuration folder/);
  });

  it("skips hidden directories, so a configuration repository can carry .git and its own CI", () => {
    const dir = folder({
      "workflows/hello.sw.yaml": workflow("hello"),
      "agents/developer.md": agent("developer"),
      ".git/config.yaml": "not: [a configuration document",
      ".github/workflows/ci.yml": "name: CI\non: [push]\njobs: {}\n",
      "agents/.drafts/broken.md": "no frontmatter",
    });

    expect(loadConfiguration(dir).workflowNames).toEqual(["hello"]);
  });

  it("loads the starter configuration with real profiles only and no binding that fires by itself", () => {
    const starter = loadConfiguration(fileURLToPath(new URL("../../../examples/config", import.meta.url)));

    expect(starter.workflowNames).toEqual(["check-workspace", "develop-issue", "hello-developer", "restart-developer"]);
    expect(starter.agentProfiles.map((profile) => [profile.metadata.name, profile.spec.harness]).sort()).toEqual([
      ["assistant", "claude-code"],
      ["developer", "claude-code"],
      ["workspace-assistant", "claude-code"],
    ]);
    expect(starter.triggerBindings.map((binding) => [binding.metadata.name, binding.spec.suspend])).toEqual([
      ["playground-nightly-check", true],
      ["playground-ready-for-agent", true],
    ]);
    expect(starter.triggerBindings.map((binding) => [binding.metadata.name, Object.keys(binding.spec.trigger), binding.spec.workspaces])).toEqual([
      ["playground-nightly-check", ["schedule"], ["playground"]],
      ["playground-ready-for-agent", ["github-issues"], ["playground"]],
    ]);
    expect(starter.notificationChannels).toEqual([]);
    expect(starter.subscriptions).toEqual([]);
    expect(starter.policies).toEqual([]);
    expect(starter.workspaces.map((workspace) => [workspace.metadata.name, workspace.spec.credentials?.secretRef.name])).toEqual([["playground", "TENDWORKS_AGENT_PLAYGROUND_TOKEN"]]);
  });

  it("ships a Pushover channel template that loads once renamed, with both credentials as platform secrets", () => {
    const examples = fileURLToPath(new URL("../../../examples/config", import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), "tend-config-"));
    cpSync(examples, dir, { recursive: true });
    copyFileSync(join(dir, "notifications", "phone.yaml.example"), join(dir, "notifications", "phone.yaml"));

    const channels = loadConfiguration(dir).notificationChannels;

    expect(channels.map((channel) => [channel.metadata.name, channel.spec.integration])).toEqual([["phone", "pushover"]]);
    expect(channels[0]?.spec.pushover).toEqual({
      token: { secretRef: { name: "TENDWORKS_PLATFORM_PUSHOVER_TOKEN" } },
      user: { secretRef: { name: "TENDWORKS_PLATFORM_PUSHOVER_USER" } },
    });
  });

  it("ships subscription templates that load once renamed, for the playground and the platform, next to the channel", () => {
    const examples = fileURLToPath(new URL("../../../examples/config", import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), "tend-config-"));
    cpSync(examples, dir, { recursive: true });
    for (const template of readdirSync(join(dir, "notifications")).filter((file) => file.endsWith(".example"))) {
      copyFileSync(join(dir, "notifications", template), join(dir, "notifications", template.replace(/\.example$/, "")));
    }

    const subscriptions = loadConfiguration(dir).subscriptions;

    expect(subscriptions.map(({ metadata, spec }) => [metadata.name, spec.scope, spec.channels])).toEqual([
      ["platform-health", { platform: {} }, ["phone"]],
      ["playground", { workspace: "playground" }, ["phone"]],
    ]);
    expect(loadConfiguration(examples).subscriptions).toEqual([]);
  });

  it("ships a read-only workspace assistant: a chat profile without the platform MCP server, enabled on the playground without writing", () => {
    const starter = loadConfiguration(fileURLToPath(new URL("../../../examples/config", import.meta.url)));

    const profile = starter.agentProfiles.find((candidate) => candidate.metadata.name === "workspace-assistant");
    expect(profile?.spec.chat).toBeDefined();
    expect(profile?.spec.mcp).toBeUndefined();
    expect(starter.workspaces.map((workspace) => [workspace.metadata.name, workspace.spec.assistant])).toEqual([["playground", { enabled: true }]]);
  });

  it("keeps repository credentials out of every starter agent profile: workspaces bring their own", () => {
    const starter = loadConfiguration(fileURLToPath(new URL("../../../examples/config", import.meta.url)));

    expect(starter.agentProfiles.filter((profile) => profile.spec.env !== undefined).map((profile) => profile.metadata.name)).toEqual([]);
  });

  it("gives the platform MCP server only to the example assistant, never to an agent with push rights", () => {
    const examples = fileURLToPath(new URL("../../../examples/config", import.meta.url));

    const readers = loadConfiguration(examples).agentProfiles.filter((profile) => profile.spec.mcp?.includes("tendworks"));

    expect(readers.map((profile) => profile.metadata.name)).toEqual(["assistant"]);
  });
});
