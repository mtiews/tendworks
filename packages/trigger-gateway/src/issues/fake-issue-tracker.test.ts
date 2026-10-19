import { createFakeIssueTracker } from "./issue-tracker.js";
import { describeIssueTracker } from "./issue-tracker.suite.js";

describeIssueTracker("fake", async (fixtures) => {
  const repository = "acme/playground";
  const issues = fixtures.map((fixture, index) => ({
    ...fixture,
    repository,
    number: index + 1,
    url: `https://issues.example/${repository}/${index + 1}`,
  }));
  // Another repository's issue must never show up.
  issues.push({ title: "elsewhere", labels: ["ready-for-agent", "bug"], state: "open", repository: "acme/other", number: 1, url: "https://issues.example/acme/other/1" });
  return { tracker: createFakeIssueTracker(issues), repository };
});
