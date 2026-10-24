import { createSecretResolver } from "@tendworks/platform";
import type { TriggerBinding, Workspace } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { stubGithubApi } from "./github-api.stub.js";
import { createGithubIssuesSource } from "./github-issues-source.js";

const settings = (name = "TENDWORKS_PLATFORM_TOKEN", overrides: Partial<TriggerBinding.GithubIssuesTrigger> = {}): TriggerBinding.GithubIssuesTrigger => ({
  labels: ["ready-for-agent"],
  every: { minutes: 1 },
  token: { secretRef: { name } },
  ...overrides,
});
const git = (name: string, url: string, credentials?: Workspace.WorkspaceCredentials): Workspace.Workspace => ({
  apiVersion: "tendworks.dev/v1",
  kind: "Workspace",
  metadata: { name },
  spec: { git: { url, defaultBranch: "main" }, ...(credentials ? { credentials } : {}) },
});
/** A directory workspace (ADR 0022), built without its type so this test does not depend on the workspace kinds this package knows. */
const directory = (name: string, path: string): Workspace.Workspace => JSON.parse(JSON.stringify({ apiVersion: "tendworks.dev/v1", kind: "Workspace", metadata: { name }, spec: { directory: { path } } })) as Workspace.Workspace;

const app = git("app", "https://github.com/acme/playground.git");
const web = git("web", "https://github.com/acme/web");
const fetch = stubGithubApi({
  token: "the-real-token",
  repositories: {
    "acme/playground": [
      { number: 7, title: "ready", state: "open", labels: ["ready-for-agent"], body: "Do it." },
      { number: 8, title: "not ready", state: "open", labels: [] },
      { number: 9, title: "a pull request", state: "open", labels: ["ready-for-agent"], pullRequest: true },
      { number: 10, title: "done", state: "closed", labels: ["ready-for-agent"] },
    ],
    "acme/web": [{ number: 1, title: "web ready", state: "open", labels: ["ready-for-agent"] }],
  },
});
const secrets = (environment: Record<string, string>) => createSecretResolver("platform", environment);
const withToken = secrets({ TENDWORKS_PLATFORM_TOKEN: "the-real-token" });
const at = new Date("2026-10-18T10:00:00.000Z");

describe("github-issues trigger source", () => {
  it("is checked at the interval of its settings", () => {
    expect(createGithubIssuesSource(settings(), { secrets: secrets({}), workspaces: [app] }).schedule).toEqual({ every: { minutes: 1 } });
  });

  it("reports the matching issues of each workspace's repository as items keyed by repository and number, without pull requests", async () => {
    const source = createGithubIssuesSource(settings(), { secrets: withToken, workspaces: [app, web] }, { fetch });

    expect(await source.items({ at, workspace: app })).toEqual([
      {
        key: "acme/playground#7",
        title: "ready",
        url: "https://github.com/acme/playground/issues/7",
        repository: "acme/playground",
        number: 7,
        body: "Do it.",
        state: "open",
        labels: ["ready-for-agent"],
      },
    ]);
    expect((await source.items({ at, workspace: web })).map((item) => item.key)).toEqual(["acme/web#1"]);
  });

  it("reports issues in the configured state", async () => {
    const source = createGithubIssuesSource(settings(undefined, { state: "closed" }), { secrets: withToken, workspaces: [app] }, { fetch });

    expect((await source.items({ at, workspace: app })).map((item) => item.key)).toEqual(["acme/playground#10"]);
  });

  it("only reads, with the platform token and never with the workspace's agent credential", async () => {
    const requests: { method: string; host: string; authorization: string | null }[] = [];
    const recording: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push({ method: request.method, host: new URL(request.url).host, authorization: request.headers.get("authorization") });
      return fetch(request);
    };
    const credential = { secretRef: { name: "TENDWORKS_AGENT_APP_TOKEN" }, env: "GH_TOKEN" };
    const workspace = git("app", "https://github.com/acme/playground.git", credential);
    const source = createGithubIssuesSource(
      settings(),
      { secrets: secrets({ TENDWORKS_PLATFORM_TOKEN: "the-real-token", TENDWORKS_AGENT_APP_TOKEN: "the-agent-token" }), workspaces: [workspace] },
      { fetch: recording },
    );

    await source.items({ at, workspace });

    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(({ method, host, authorization }) => method === "GET" && host === "api.github.com" && authorization === "Bearer the-real-token")).toBe(true);
  });

  it("fails the check, naming the secret, when the referenced secret is not set", async () => {
    const source = createGithubIssuesSource(settings(), { secrets: secrets({ TENDWORKS_PLATFORM_TOKEN: "" }), workspaces: [app] }, { fetch });

    await expect(source.items({ at, workspace: app })).rejects.toThrow("secret TENDWORKS_PLATFORM_TOKEN is not set");
  });

  it("never resolves a secret that is not a platform secret, e.g. another variable of the server", async () => {
    const source = createGithubIssuesSource(settings("TEND_DATABASE_URL"), { secrets: secrets({ TEND_DATABASE_URL: "the-real-token" }), workspaces: [app] }, { fetch });

    await expect(source.items({ at, workspace: app })).rejects.toThrow("TEND_DATABASE_URL is not a platform secret");
  });

  it("refuses a binding without workspaces, since it has no repository to read", () => {
    expect(() => createGithubIssuesSource(settings(), { secrets: withToken, workspaces: [] })).toThrow(
      "github-issues reads the issues of the binding's workspaces' repositories, but the binding names no workspace",
    );
  });

  it("refuses a binding with a workspace that is not a repository on github.com, naming the workspace", () => {
    const forgejo = git("forgejo", "https://git.example/acme/playground.git");

    expect(() => createGithubIssuesSource(settings(), { secrets: withToken, workspaces: [app, forgejo] })).toThrow(
      "workspace 'forgejo' is not a repository on github.com (https://git.example/acme/playground.git); github-issues reads issues on github.com only",
    );
  });

  it("refuses a binding with a directory workspace, which has no repository", () => {
    expect(() => createGithubIssuesSource(settings(), { secrets: withToken, workspaces: [directory("notes", "/srv/notes")] })).toThrow(
      "workspace 'notes' is not a git repository; github-issues reads issues on github.com only",
    );
  });

  it("refuses a check for a workspace the binding does not name", async () => {
    const source = createGithubIssuesSource(settings(), { secrets: withToken, workspaces: [app] }, { fetch });

    await expect(source.items({ at, workspace: web })).rejects.toThrow("workspace 'web' is not one of the binding's workspaces");
    await expect(source.items({ at })).rejects.toThrow("github-issues is checked per workspace, but this check names none");
  });
});
