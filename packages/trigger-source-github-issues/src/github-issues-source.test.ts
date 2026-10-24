import { createSecretResolver } from "@tendworks/platform";
import type { TriggerBinding, Workspace } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { stubGithubApi } from "./github-api.stub.js";
import { createGithubIssuesSource } from "./github-issues-source.js";

const settings = (name = "TENDWORKS_PLATFORM_TOKEN"): TriggerBinding.GithubIssuesTrigger => ({
  labels: ["ready-for-agent"],
  every: { minutes: 1 },
  token: { secretRef: { name } },
});
const git = (name: string, url: string): Workspace.Workspace => ({
  apiVersion: "tendworks.dev/v1",
  kind: "Workspace",
  metadata: { name },
  spec: { git: { url, defaultBranch: "main" } },
});
const fetch = stubGithubApi({
  token: "the-real-token",
  repositories: {
    "acme/playground": [
      { number: 7, title: "ready", state: "open", labels: ["ready-for-agent"], body: "Do it." },
      { number: 8, title: "not ready", state: "open", labels: [] },
    ],
    "acme/web": [{ number: 1, title: "web ready", state: "open", labels: ["ready-for-agent"] }],
  },
});
const secrets = (environment: Record<string, string>) => createSecretResolver("platform", environment);
const at = new Date("2026-10-18T10:00:00.000Z");

describe("github-issues trigger source", () => {
  it("is checked at the interval of its settings", () => {
    expect(createGithubIssuesSource(settings(), { secrets: secrets({}) }).schedule).toEqual({ every: { minutes: 1 } });
  });

  it("reports the matching issues of the workspace's repository as items keyed by repository and number", async () => {
    const source = createGithubIssuesSource(settings(), { secrets: secrets({ TENDWORKS_PLATFORM_TOKEN: "the-real-token" }) }, { fetch });

    expect(await source.items({ at, workspace: git("app", "https://github.com/acme/playground.git") })).toEqual([
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
    expect((await source.items({ at, workspace: git("web", "https://github.com/acme/web") })).map((item) => item.key)).toEqual(["acme/web#1"]);
  });

  it("fails the check, naming the secret, when the referenced secret is not set", async () => {
    const source = createGithubIssuesSource(settings(), { secrets: secrets({ TENDWORKS_PLATFORM_TOKEN: "" }) }, { fetch });

    await expect(source.items({ at, workspace: git("app", "https://github.com/acme/playground.git") })).rejects.toThrow(
      "secret TENDWORKS_PLATFORM_TOKEN is not set",
    );
  });

  it("never resolves a secret that is not a platform secret, e.g. another variable of the server", async () => {
    const source = createGithubIssuesSource(settings("TEND_DATABASE_URL"), { secrets: secrets({ TEND_DATABASE_URL: "the-real-token" }) }, { fetch });

    await expect(source.items({ at, workspace: git("app", "https://github.com/acme/playground.git") })).rejects.toThrow(
      "TEND_DATABASE_URL is not a platform secret",
    );
  });

  it("refuses a check without a workspace, or for a workspace that is not a repository on GitHub", async () => {
    const source = createGithubIssuesSource(settings(), { secrets: secrets({ TENDWORKS_PLATFORM_TOKEN: "the-real-token" }) }, { fetch });

    await expect(source.items({ at })).rejects.toThrow("github-issues reads the repositories of the binding's workspaces, but the binding names none");
    await expect(source.items({ at, workspace: git("forgejo", "https://git.example/acme/playground.git") })).rejects.toThrow(
      "workspace 'forgejo' is not a repository on github.com (https://git.example/acme/playground.git)",
    );
  });
});
