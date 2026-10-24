import type { TriggerBinding } from "@tendworks/shared";
import type { TriggerSource } from "@tendworks/trigger-gateway/source";

/**
 * Trigger source of kind `schedule` (ADR 0023): fires at every execution of its cron
 * expression or interval. The tick is the one item, keyed by the time of the execution,
 * so each execution starts one run per workspace, and only once.
 */
export function createScheduleSource(settings: TriggerBinding.TriggerSchedule): TriggerSource {
  return {
    schedule: structuredClone(settings),
    async items({ at }) {
      const time = at.toISOString();
      return [{ key: time, title: `Scheduled at ${time}`, at: time }];
    },
  };
}
