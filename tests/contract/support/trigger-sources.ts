import { createFakeTriggerSource, fakeTriggerBinding, type TriggerSources } from "@tendworks/trigger-gateway";
import { createGithubIssuesSource } from "@tendworks/trigger-source-github-issues";
import { createScheduleSource } from "@tendworks/trigger-source-schedule";
import type { TriggerBinding } from "@tendworks/shared";

/**
 * The trigger sources the server bundle deploys (apps/server/src/trigger-sources.ts), which
 * tests may not import, plus the test-only kind `fake`, which the platform does not deploy.
 */
export const TRIGGER_SOURCES: TriggerSources = {
  schedule: createScheduleSource,
  "github-issues": createGithubIssuesSource,
  fake: createFakeTriggerSource,
};

/**
 * The bindings of the fake kind the contract tests rely on. They are not configuration
 * files: the binding schema does not know the kind, so the platform refuses them.
 */
const FAKE_BINDINGS: readonly TriggerBinding.TriggerBinding[] = [
  // The whole automated chain with fakes: one issue starts one fake-develop-issue run in fake-playground.
  fakeTriggerBinding(
    { name: "fake-issue-to-pull-request" },
    {
      workflow: "fake-develop-issue",
      workspaces: ["fake-playground"],
      trigger: {
        every: { seconds: 10 },
        items: [{ key: "chain/playground#201", title: "Open a pull request", url: "https://issues.example/chain/playground/201", number: 201 }],
      },
    },
  ),
  // hello-agent once for every item, without a workspace.
  fakeTriggerBinding(
    { name: "issue-ready-for-agent" },
    {
      workflow: "hello-agent",
      trigger: {
        every: { seconds: 10 },
        items: [
          { key: "example/playground#101", title: "Add a greeting", url: "https://issues.example/example/playground/101", number: 101 },
          { key: "example/playground#102", title: "Fix the typo", url: "https://issues.example/example/playground/102", number: 102 },
        ],
      },
    },
  ),
];

/** The configured bindings together with the fake ones, ordered by name like the configuration's. */
export function withFakeBindings(bindings: readonly TriggerBinding.TriggerBinding[]): TriggerBinding.TriggerBinding[] {
  return [...bindings, ...FAKE_BINDINGS].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}
