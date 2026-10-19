import type { TriggerBinding } from "@tendworks/shared";

/** Length of a Serverless Workflow inline duration in milliseconds. */
export function durationMs({ days = 0, hours = 0, minutes = 0, seconds = 0 }: TriggerBinding.Duration): number {
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/**
 * The first execution strictly after `now`. Executions fall on multiples of the interval
 * since the Unix epoch, so they need no stored state and every instance agrees on them.
 */
export function nextExecution(schedule: TriggerBinding.TriggerSchedule, now: Date): Date {
  const interval = Math.max(1000, durationMs(schedule.every));
  return new Date((Math.floor(now.getTime() / interval) + 1) * interval);
}
