import { describe, expect, it } from "vitest";
import { formatCost, formatOrigin, formatSchedule, totalCost } from "./index.js";

describe("formatting for clients", () => {
  it("shows a cost with at most four decimals", () => {
    expect(formatCost({ amount: 0.123456, currency: "USD" })).toBe("0.1235 USD");
    expect(formatCost({ amount: 0.1 + 0.2, currency: "USD" })).toBe("0.3 USD");
  });

  it("sums costs per currency", () => {
    const costs = [
      { amount: 0.25, currency: "USD" },
      { amount: 1, currency: "EUR" },
      { amount: 0.25, currency: "USD" },
    ];

    expect(totalCost(costs)).toBe("0.5 USD, 1 EUR");
    expect(totalCost([])).toBe("");
  });

  it("shows what started a run: the binding, the workspace and the item, with its link on request", () => {
    const trigger = {
      kind: "trigger" as const,
      binding: "ready",
      workspace: "app",
      item: { key: "acme/playground#7", title: "Fix the login", url: "https://example.test/acme/playground/issues/7" },
    };
    const tick = { kind: "trigger" as const, binding: "nightly", item: { key: "2026-10-18T02:00:00.000Z", title: "Scheduled at 2026-10-18T02:00:00.000Z" } };

    expect(formatOrigin({ kind: "manual" })).toBe("manual");
    expect(formatOrigin(trigger)).toBe("trigger ready in app: acme/playground#7");
    expect(formatOrigin(trigger, { url: true })).toBe("trigger ready in app: acme/playground#7 (https://example.test/acme/playground/issues/7)");
    expect(formatOrigin(tick, { url: true })).toBe("trigger nightly: 2026-10-18T02:00:00.000Z");
    expect(formatOrigin(undefined)).toBe("");
  });

  it("shows a trigger's schedule as its interval or its cron expression", () => {
    expect(formatSchedule({ every: { minutes: 5, seconds: 30 } })).toBe("every 5m30s");
    expect(formatSchedule({ every: { days: 1 } })).toBe("every 1d");
    expect(formatSchedule({ every: {} })).toBe("every 0s");
    expect(formatSchedule({ cron: "0 2 * * *" })).toBe("cron 0 2 * * *");
  });
});
