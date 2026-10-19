import { describe, expect, it } from "vitest";
import { stubGithubApi } from "./github/github-api.stub.js";
import { createPullRequestIntegrations } from "./pull-requests-for.js";

describe("pull request integrations", () => {
  const fetch = stubGithubApi({ token: "platform-token", repositories: { "acme/app": [{ number: 1, state: "open", mergeable: true }] } });

  it("merges github.com pull requests on GitHub with the platform token, read when merging", async () => {
    let token: string | undefined;
    const integrations = createPullRequestIntegrations({ githubToken: () => token, fetch });
    const github = integrations("https://github.com/acme/app/pull/1")!;

    await expect(github.merge("https://github.com/acme/app/pull/1")).rejects.toThrow(
      "secret TENDWORKS_PLATFORM_GITHUB_TOKEN is not set",
    );
    token = "platform-token";
    await expect(github.merge("https://github.com/acme/app/pull/1")).resolves.toMatchObject({ commit: expect.any(String) });
  });

  it("merges pull requests on reserved .example hosts in the fake, where every pull request is open", async () => {
    const integrations = createPullRequestIntegrations({ githubToken: () => undefined });

    await expect(integrations("https://git.example/acme/app/pull/3")!.merge("https://git.example/acme/app/pull/3")).resolves.toBeDefined();
  });

  it("has no integration for other hosts", () => {
    const integrations = createPullRequestIntegrations({ githubToken: () => "t" });

    expect(integrations("https://gitlab.com/acme/app/-/merge_requests/1")).toBeUndefined();
    expect(integrations("not a url")).toBeUndefined();
  });
});
