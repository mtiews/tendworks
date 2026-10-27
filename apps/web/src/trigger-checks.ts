import type { ControlPlane } from "@tendworks/shared";

type Trigger = ControlPlane.components["schemas"]["triggerList"]["items"][number];

/** The timeline reaches this far back and ahead. */
export const WINDOW_MS = 12 * 60 * 60 * 1_000;
/** More checks than this in a window are drawn as one band, not as single marks. */
const DENSE = 96;

const UNIT_MS = { days: 86_400_000, hours: 3_600_000, minutes: 60_000, seconds: 1_000 } as const;

export interface Checks {
  /** Times of checks in the last 12 hours, as fractions of the whole window (0 = 12 h ago, 0.5 = now, 1 = in 12 h). */
  past: number[];
  future: number[];
  /** So many checks that the timeline shows a band. */
  dense: boolean;
}

/**
 * The checks of a binding around `now`. The API gives only the next and the last check, so
 * an interval is projected from the next check in both directions, while a cron expression
 * (which the browser does not evaluate) shows just the next and the last check. A suspended
 * binding checks nothing; a binding fired by hand has no schedule, so it shows its last firing only.
 */
export function checksAround(trigger: Trigger, now: number): Checks {
  if (trigger.suspended) return { past: [], future: [], dense: false };
  const next = trigger.nextExecutionAt === undefined ? Number.NaN : new Date(trigger.nextExecutionAt).getTime();
  const last = trigger.lastEvaluation ? new Date(trigger.lastEvaluation.at).getTime() : undefined;
  const times = new Set<number>();
  if (next > now) times.add(next);
  if (last !== undefined) times.add(last);
  if (trigger.schedule && "every" in trigger.schedule) {
    const every = trigger.schedule.every;
    const interval = (Object.keys(UNIT_MS) as (keyof typeof UNIT_MS)[]).reduce((sum, unit) => sum + (every[unit] ?? 0) * UNIT_MS[unit], 0);
    if (interval > 0 && Number.isFinite(next)) {
      // Reach the first check at or after the window's start, then walk through it.
      const first = next - Math.floor((next - (now - WINDOW_MS)) / interval) * interval;
      if ((now + WINDOW_MS - first) / interval > DENSE * 2) return { past: [], future: [], dense: true };
      for (let time = first; time <= now + WINDOW_MS; time += interval) times.add(time);
    }
  }
  const fraction = (time: number) => (time - (now - WINDOW_MS)) / (2 * WINDOW_MS);
  const inWindow = [...times].filter((time) => Math.abs(time - now) <= WINDOW_MS).sort((a, b) => a - b);
  const past = inWindow.filter((time) => time <= now).map(fraction);
  const future = inWindow.filter((time) => time > now).map(fraction);
  return { past, future, dense: past.length + future.length > DENSE };
}
