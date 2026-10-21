import { describe, expect, it } from "vitest";
import { formatCost, formatOrigin, totalCost } from "./index.js";

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

  it("shows what started a run, with the issue's address on request", () => {
    const trigger = { kind: "trigger" as const, binding: "ready", issue: { repository: "acme/playground", number: 7, url: "https://example.test/acme/playground/issues/7" } };

    expect(formatOrigin({ kind: "manual" })).toBe("manual");
    expect(formatOrigin(trigger)).toBe("trigger ready: acme/playground#7");
    expect(formatOrigin(trigger, { url: true })).toBe("trigger ready: acme/playground#7 (https://example.test/acme/playground/issues/7)");
    expect(formatOrigin(undefined)).toBe("");
  });
});
