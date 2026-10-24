import { createFakeTriggerSource, type TriggerSources } from "@tendworks/trigger-gateway";
import { createGithubIssuesSource } from "@tendworks/trigger-source-github-issues";
import { createScheduleSource } from "@tendworks/trigger-source-schedule";

/**
 * The trigger sources deployed with this bundle, by trigger kind (ADR 0023). A new kind
 * is a new source package plus one line here; the trigger gateway itself does not change.
 */
export const TRIGGER_SOURCES: TriggerSources = {
  schedule: createScheduleSource,
  "github-issues": createGithubIssuesSource,
  fake: createFakeTriggerSource,
};
