import { createFakeTriggerSource, type TriggerSources } from "@tendworks/trigger-gateway";
import { createGithubIssuesSource } from "@tendworks/trigger-source-github-issues";
import { createScheduleSource } from "@tendworks/trigger-source-schedule";

/** The trigger sources the server bundle deploys (apps/server/src/trigger-sources.ts), which tests may not import. */
export const TRIGGER_SOURCES: TriggerSources = {
  schedule: createScheduleSource,
  "github-issues": createGithubIssuesSource,
  fake: createFakeTriggerSource,
};
