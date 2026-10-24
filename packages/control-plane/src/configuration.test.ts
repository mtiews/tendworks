import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

const trigger = (name: string, workflowName: string) => `
apiVersion: tendworks.dev/v1
kind: TriggerBinding
metadata: { name: ${name} }
spec:
  schedule:
    every: { minutes: 5 }
  source:
    integration: fake
    issues: { repository: acme/playground, labels: [ready-for-agent], state: open }
  workflow: ${workflowName}
  input:
    issue: '\${ .issue }'
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
    expect(issues[1]).toBe("triggers/x.yaml: unknown kind 'Gizmo' (known: AgentProfile, NotificationChannel, Policy, SandboxTemplate, TriggerBinding)");
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
    });

    const configuration = loadConfiguration(dir);

    expect(configuration.triggerBindings).toEqual([
      {
        apiVersion: "tendworks.dev/v1",
        kind: "TriggerBinding",
        metadata: { name: "ready" },
        spec: {
          schedule: { every: { minutes: 5 } },
          source: { integration: "fake", issues: { repository: "acme/playground", labels: ["ready-for-agent"], state: "open" } },
          workflow: "build",
          input: { issue: "${ .issue }" },
        },
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
      "triggers/d.yaml": trigger("broken", "build").replace("minutes: 5", "fortnights: 1"),
    });

    expect(issuesOf(dir)).toEqual([
      "triggers/b.yaml: trigger binding 'ready' is already defined in triggers/a.yaml",
      "triggers/d.yaml: /spec/schedule/every: unsupported property 'fortnights'",
      "triggers/c.yaml: trigger binding 'ghostly' starts workflow 'ghost', but no workflow 'ghost' is configured",
    ]);
  });

  it("accepts a GitHub source only with its token as a secret reference", () => {
    const github = (settings: string) =>
      trigger("github", "build").replace("integration: fake", `integration: github${settings}`);
    const valid = folder({
      "workflows/build.sw.yaml": workflow("build"),
      "agents/developer.md": agent("developer"),
      "triggers/github.yaml": github("\n    github: { token: { secretRef: { name: TENDWORKS_PLATFORM_GITHUB_TOKEN } } }"),
    });
    expect(loadConfiguration(valid).triggerBindings[0]?.spec.source).toMatchObject({
      integration: "github",
      github: { token: { secretRef: { name: "TENDWORKS_PLATFORM_GITHUB_TOKEN" } } },
    });

    const invalid = folder({
      "workflows/build.sw.yaml": workflow("build"),
      "agents/developer.md": agent("developer"),
      "triggers/a.yaml": github("").replace("name: github", "name: a"),
      "triggers/b.yaml": github("\n    github: { token: github_pat_plaintext }").replace("name: github", "name: b"),
    });
    expect(issuesOf(invalid)).toEqual([
      "triggers/a.yaml: /spec/source: must have required property 'github'",
      "triggers/b.yaml: /spec/source/github/token: must be object",
    ]);
  });

  it("lets agent profiles reference only agent secrets and trigger bindings only platform secrets", () => {
    const github = (secret: string) =>
      trigger("github", "build").replace("integration: fake", `integration: github\n    github: { token: { secretRef: { name: ${secret} } } }`);
    const dir = folder({
      "workflows/build.sw.yaml": workflow("build"),
      "agents/developer.md": agent("developer", "harness: fake\n  env: { GH_TOKEN: { secretRef: { name: TENDWORKS_PLATFORM_GITHUB_TOKEN } } }"),
      "triggers/github.yaml": github("TENDWORKS_AGENT_GITHUB_TOKEN"),
    });

    expect(issuesOf(dir)).toEqual([
      `agents/developer.md: /spec/env/GH_TOKEN/secretRef/name: must match pattern "^TENDWORKS_AGENT_[A-Z0-9_]+$"`,
      `triggers/github.yaml: /spec/source/github/token/secretRef/name: must match pattern "^TENDWORKS_PLATFORM_[A-Z0-9_]+$"`,
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

  it("loads notification channels with the events they select, ordered by name", () => {
    const dir = folder({
      "notifications/phone.yaml": `apiVersion: tendworks.dev/v1
kind: NotificationChannel
metadata: { name: phone }
spec:
  integration: pushover
  events: [run.failed, approval.requested]
  pushover:
    token: { secretRef: { name: TENDWORKS_PLATFORM_PUSHOVER_TOKEN } }
    user: { secretRef: { name: TENDWORKS_PLATFORM_PUSHOVER_USER } }
    priority: 1
`,
      "notifications/log.yaml": "apiVersion: tendworks.dev/v1\nkind: NotificationChannel\nmetadata: { name: log }\nspec: { integration: fake, events: [run.completed] }\n",
    });

    expect(loadConfiguration(dir).notificationChannels.map(({ metadata, spec }) => [metadata.name, spec])).toEqual([
      ["log", { integration: "fake", events: ["run.completed"] }],
      [
        "phone",
        {
          integration: "pushover",
          events: ["run.failed", "approval.requested"],
          pushover: {
            token: { secretRef: { name: "TENDWORKS_PLATFORM_PUSHOVER_TOKEN" } },
            user: { secretRef: { name: "TENDWORKS_PLATFORM_PUSHOVER_USER" } },
            priority: 1,
          },
        },
      ],
    ]);
  });

  it("rejects a notification channel without its settings, with plain or agent secrets, unknown events and duplicates", () => {
    const channel = (name: string, spec: string) => `apiVersion: tendworks.dev/v1\nkind: NotificationChannel\nmetadata: { name: ${name} }\nspec: ${spec}\n`;
    const dir = folder({
      "notifications/a.yaml": channel("log", "{ integration: fake, events: [run.completed] }"),
      "notifications/b.yaml": channel("log", "{ integration: fake, events: [run.failed] }"),
      "notifications/c.yaml": channel("bare", "{ integration: pushover, events: [run.failed] }"),
      "notifications/d.yaml": channel(
        "leaky",
        "{ integration: pushover, events: [run.failed], pushover: { token: plaintext, user: { secretRef: { name: TENDWORKS_AGENT_PUSHOVER_USER } } } }",
      ),
      "notifications/e.yaml": channel("noisy", "{ integration: fake, events: [step.started] }"),
      "notifications/f.yaml": channel("silent", "{ integration: fake, events: [] }"),
      "notifications/g.yaml": channel(
        "emergency",
        "{ integration: pushover, events: [run.failed], pushover: { token: { secretRef: { name: TENDWORKS_PLATFORM_PUSHOVER_TOKEN } }, user: { secretRef: { name: TENDWORKS_PLATFORM_PUSHOVER_USER } }, priority: 2 } }",
      ),
    });

    expect(issuesOf(dir)).toEqual([
      "notifications/b.yaml: notification channel 'log' is already defined in notifications/a.yaml",
      "notifications/c.yaml: /spec: must have required property 'pushover'",
      "notifications/d.yaml: /spec/pushover/token: must be object",
      `notifications/d.yaml: /spec/pushover/user/secretRef/name: must match pattern "^TENDWORKS_PLATFORM_[A-Z0-9_]+$"`,
      "notifications/e.yaml: /spec/events/0: must be equal to one of the allowed values (approval.requested, run.failed, run.completed)",
      "notifications/f.yaml: /spec/events: must NOT have fewer than 1 items",
      "notifications/g.yaml: /spec/pushover/priority: must be <= 1",
    ]);
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

    expect(starter.workflowNames).toEqual(["develop-issue", "hello-developer", "restart-developer"]);
    expect(starter.agentProfiles.map((profile) => [profile.metadata.name, profile.spec.harness]).sort()).toEqual([
      ["assistant", "claude-code"],
      ["developer", "claude-code"],
    ]);
    expect(starter.triggerBindings.map((binding) => [binding.metadata.name, binding.spec.suspend])).toEqual([["playground-ready-for-agent", true]]);
  });

  it("gives the platform MCP server only to the example assistant, never to an agent with push rights", () => {
    const examples = fileURLToPath(new URL("../../../examples/config", import.meta.url));

    const readers = loadConfiguration(examples).agentProfiles.filter((profile) => profile.spec.mcp?.includes("tendworks"));

    expect(readers.map((profile) => profile.metadata.name)).toEqual(["assistant"]);
  });
});
