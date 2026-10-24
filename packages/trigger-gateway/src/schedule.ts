import type { TriggerBinding } from "@tendworks/shared";
import { CronExpressionParser } from "cron-parser";

type Schedule = TriggerBinding.TriggerSchedule;

/** Length of a Serverless Workflow inline duration in milliseconds. */
export function durationMs({ days = 0, hours = 0, minutes = 0, seconds = 0 }: TriggerBinding.Duration): number {
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

const intervalMs = (every: TriggerBinding.Duration) => Math.max(1000, durationMs(every));

function cron(expression: string, currentDate: Date) {
  try {
    return CronExpressionParser.parse(expression, { currentDate, tz: "UTC" });
  } catch (error) {
    throw new Error(`cron expression '${expression}' is invalid: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Throws when the schedule cannot be evaluated, e.g. a cron expression with a field out of range. */
export function checkSchedule(schedule: Schedule): void {
  if ("cron" in schedule) cron(schedule.cron, new Date(0));
}

/**
 * The first execution strictly after `now`. Interval executions fall on multiples of the
 * interval since the Unix epoch and cron executions on the times of the expression in
 * UTC, so they need no stored state and every instance agrees on them.
 */
export function nextExecution(schedule: Schedule, now: Date): Date {
  if ("cron" in schedule) return cron(schedule.cron, now).next().toDate();
  const interval = intervalMs(schedule.every);
  return new Date((Math.floor(now.getTime() / interval) + 1) * interval);
}

/** The last execution at or before `now`: the one a check at `now` belongs to. */
export function latestExecution(schedule: Schedule, now: Date): Date {
  if ("cron" in schedule) return cron(schedule.cron, new Date(now.getTime() + 1)).prev().toDate();
  const interval = intervalMs(schedule.every);
  return new Date(Math.floor(now.getTime() / interval) * interval);
}
