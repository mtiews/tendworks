import { createSecretResolver } from "@tendworks/platform";
import type { PullRequestIntegration } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { stubGithubApi } from "./github/github-api.stub.js";
import { createPullRequestIntegrations } from "./pull-requests-for.js";

const integration = (name: string, spec: PullRequestIntegration.PullRequestIntegrationSpec): PullRequestIntegration.PullRequestIntegration => ({
  apiVersion: "tendworks.dev/v1",
  kind: "PullRequestIntegration",
  metadata: { name },
  spec,
});
const github = integration("github", { host: "github.com", integration: "github", github: { token: { secretRef: { name: "TENDWORKS_PLATFORM_GITHUB_TOKEN" } } } });
const fake = integration("fake", {
  host: "git.example",
  integration: "fake",
  fake: { pullRequests: [{ url: "https://git.example/acme/app/pull/3", headBranch: "tendworks/issue-3" }] },
});

describe("pull request integrations", () => {
  const fetch = stubGithubApi({ token: "platform-token", repositories: { "acme/app": [{ number: 1, state: "open", mergeable: true }] } });

  it("merges pull requests on the host of a github integration with the platform token it references, read when merging", async () => {
    const environment: Record<string, string> = {};
    const integrations = createPullRequestIntegrations({ integrations: [github], secrets: createSecretResolver("platform", environment), fetch });
    const pullRequests = integrations("https://github.com/acme/app/pull/1")!;

    await expect(pullRequests.merge("https://github.com/acme/app/pull/1")).rejects.toThrow("secret TENDWORKS_PLATFORM_GITHUB_TOKEN is not set");
    environment.TENDWORKS_PLATFORM_GITHUB_TOKEN = "platform-token";
    await expect(pullRequests.merge("https://github.com/acme/app/pull/1")).resolves.toMatchObject({ commit: expect.any(String) });
  });

  it("merges the pull requests a configured fake integration lists, and no others", async () => {
    const integrations = createPullRequestIntegrations({ integrations: [fake], secrets: createSecretResolver("platform", {}) });
    const pullRequests = integrations("https://git.example/acme/app/pull/3")!;

    await expect(pullRequests.merge("https://git.example/acme/app/pull/3")).resolves.toBeDefined();
    await expect(pullRequests.merge("https://git.example/acme/app/pull/4")).rejects.toThrow("no pull request at https://git.example/acme/app/pull/4");
  });

  it("has no integration for a host none is configured for, not even a reserved one", () => {
    const integrations = createPullRequestIntegrations({ integrations: [github], secrets: createSecretResolver("platform", {}) });

    expect(integrations("https://git.example/acme/app/pull/3")).toBeUndefined();
    expect(integrations("https://gitlab.com/acme/app/-/merge_requests/1")).toBeUndefined();
    expect(integrations("not a url")).toBeUndefined();
  });
});
