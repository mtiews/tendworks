import { describe, expect, it } from "vitest";
import { decide, type Policy } from "./policy.js";

const policy = (merge: "auto" | "ask"): Policy => ({
  apiVersion: "tendworks.dev/v1",
  kind: "Policy",
  metadata: { name: "merge-gate" },
  spec: { merge },
});

describe("policy decision", () => {
  it("allows merging a pull request right away with merge: auto", () => {
    expect(decide(policy("auto"), { action: "merge" })).toBe("allow");
  });

  it("asks before merging a pull request with merge: ask", () => {
    expect(decide(policy("ask"), { action: "merge" })).toBe("ask");
  });
});
