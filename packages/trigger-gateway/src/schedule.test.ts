import { describe, expect, it } from "vitest";
import { checkSchedule, latestExecution, nextExecution } from "./schedule.js";

const at = (time: string) => new Date(`2026-10-18T${time}Z`);
const iso = (date: Date) => date.toISOString();

describe("an interval schedule", () => {
  const every5 = { every: { minutes: 5 } };

  it("executes on multiples of the interval since the epoch, strictly after now", () => {
    expect(iso(nextExecution(every5, at("10:02:30.000")))).toBe("2026-10-18T10:05:00.000Z");
    expect(iso(nextExecution(every5, at("10:05:00.000")))).toBe("2026-10-18T10:10:00.000Z");
    expect(iso(nextExecution({ every: { days: 1 } }, at("10:02:30.000")))).toBe("2026-10-19T00:00:00.000Z");
  });

  it("names the latest execution at or before now", () => {
    expect(iso(latestExecution(every5, at("10:02:30.000")))).toBe("2026-10-18T10:00:00.000Z");
    expect(iso(latestExecution(every5, at("10:05:00.000")))).toBe("2026-10-18T10:05:00.000Z");
  });

  it("never executes more often than once a second", () => {
    expect(iso(nextExecution({ every: { seconds: 0 } }, at("10:02:30.200")))).toBe("2026-10-18T10:02:31.000Z");
  });
});

describe("a cron schedule", () => {
  const nightly = { cron: "0 2 * * *" };
  const quarterly = { cron: "*/15 * * * *" };

  it("executes at the times of the expression in UTC, strictly after now", () => {
    expect(iso(nextExecution(nightly, at("10:02:30.000")))).toBe("2026-10-19T02:00:00.000Z");
    expect(iso(nextExecution(quarterly, at("10:02:30.000")))).toBe("2026-10-18T10:15:00.000Z");
    expect(iso(nextExecution(quarterly, at("10:15:00.000")))).toBe("2026-10-18T10:30:00.000Z");
  });

  it("names the latest execution at or before now", () => {
    expect(iso(latestExecution(nightly, at("10:02:30.000")))).toBe("2026-10-18T02:00:00.000Z");
    expect(iso(latestExecution(quarterly, at("10:15:00.000")))).toBe("2026-10-18T10:15:00.000Z");
    expect(iso(latestExecution(quarterly, at("10:14:59.999")))).toBe("2026-10-18T10:00:00.000Z");
  });

  it("refuses an expression it cannot read, naming it", () => {
    expect(() => checkSchedule({ cron: "61 * * * *" })).toThrow("cron expression '61 * * * *'");
    expect(() => checkSchedule(nightly)).not.toThrow();
    expect(() => checkSchedule({ every: { minutes: 5 } })).not.toThrow();
  });
});
