import { createSecretResolver } from "@tendworks/platform";
import { describe, expect, it } from "vitest";
import { stubGithubApi } from "./github/github-api.stub.js";
import type { IssueSource } from "./issue-tracker.js";
import { issueTrackerFor } from "./issue-tracker-for.js";

describe("issue tracker for a binding's source", () => {
  const github = (name = "TENDWORKS_PLATFORM_TOKEN"): IssueSource => ({
    integration: "github",
    issues: { repository: "acme/playground", labels: ["ready-for-agent"] },
    github: { token: { secretRef: { name } } },
  });
  const fetch = stubGithubApi({
    token: "the-real-token",
    repositories: { "acme/playground": [{ number: 7, title: "ready", state: "open", labels: ["ready-for-agent"] }] },
  });
  const secrets = (environment: Record<string, string>) => createSecretResolver("platform", environment);

  it("asks GitHub with the token the source's secret reference names", async () => {
    const tracker = issueTrackerFor(github(), { secrets: secrets({ TENDWORKS_PLATFORM_TOKEN: "the-real-token" }), fetch });

    expect((await tracker.findIssues(github().issues)).map((issue) => issue.url)).toEqual(["https://github.com/acme/playground/issues/7"]);
  });

  it("fails the check, naming the secret, when the referenced secret is not set", async () => {
    const tracker = issueTrackerFor(github(), { secrets: secrets({ TENDWORKS_PLATFORM_TOKEN: "" }), fetch });

    await expect(tracker.findIssues(github().issues)).rejects.toThrow("secret TENDWORKS_PLATFORM_TOKEN is not set");
  });

  it("never resolves a secret that is not a platform secret, e.g. another variable of the server", async () => {
    const tracker = issueTrackerFor(github("TEND_DATABASE_URL"), { secrets: secrets({ TEND_DATABASE_URL: "the-real-token" }), fetch });

    await expect(tracker.findIssues(github().issues)).rejects.toThrow("TEND_DATABASE_URL is not a platform secret");
  });

  it("serves the issues a fake source lists", async () => {
    const issue = { repository: "acme/playground", number: 1, title: "t", state: "open" as const, labels: [], url: "https://issues.example/1" };
    const tracker = issueTrackerFor({ integration: "fake", issues: { repository: "acme/playground" }, fake: { issues: [issue] } }, { secrets: secrets({}) });

    expect(await tracker.findIssues({ repository: "acme/playground" })).toEqual([issue]);
  });
});
