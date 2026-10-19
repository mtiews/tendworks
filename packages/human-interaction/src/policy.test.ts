import { describe, expect, it } from "vitest";
import { decide, decideFor, type Policy } from "./policy.js";

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

describe("policy decision across the configured policies", () => {
  const named = (name: string, merge: "auto" | "ask", workflows?: [string, ...string[]]): Policy => ({
    ...policy(merge),
    metadata: { name },
    spec: workflows ? { merge, workflows } : { merge },
  });

  it("applies a policy without workflows to every workflow", () => {
    expect(decideFor([named("everything", "auto")], { action: "merge", workflow: "any" })).toEqual({ decision: "allow", policy: "everything" });
  });

  it("applies a policy with workflows only to those", () => {
    const policies = [named("careful", "ask", ["release"]), named("quick", "auto", ["develop-issue"])];

    expect(decideFor(policies, { action: "merge", workflow: "develop-issue" })).toEqual({ decision: "allow", policy: "quick" });
    expect(decideFor(policies, { action: "merge", workflow: "other" })).toBeUndefined();
  });

  it("lets the strictest applicable policy win, whatever their order", () => {
    const policies = [named("everything", "auto"), named("careful", "ask", ["develop-issue"]), named("also", "auto", ["develop-issue"])];

    expect(decideFor(policies, { action: "merge", workflow: "develop-issue" })).toEqual({ decision: "ask", policy: "careful" });
    expect(decideFor([...policies].reverse(), { action: "merge", workflow: "develop-issue" })).toEqual({ decision: "ask", policy: "careful" });
  });
});
