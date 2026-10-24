import { describe, expect, it } from "vitest";
import { decideFor, type Policy } from "./policy.js";

const policy = (name: string, actions: Policy["spec"]["actions"], workflows?: NonNullable<Policy["spec"]["workflows"]>): Policy => ({
  apiVersion: "tendworks.dev/v1",
  kind: "Policy",
  metadata: { name },
  spec: workflows ? { actions, workflows } : { actions },
});

describe("policy decision for a human step", () => {
  it("asks when no policy applies", () => {
    expect(decideFor([], { action: "deploy", workflow: "release-app" })).toEqual({ decision: "ask" });
  });

  it("allows an action a policy of the workflow allows", () => {
    const policies = [policy("trusted", { deploy: "allow" }, ["release-app"])];

    expect(decideFor(policies, { action: "deploy", workflow: "release-app" })).toEqual({ decision: "allow", policy: "trusted" });
  });

  it("ignores policies of other workflows and for other actions", () => {
    const policies = [policy("other-workflow", { deploy: "allow" }, ["nightly-scan"]), policy("other-action", { "merge-pull-request": "allow" })];

    expect(decideFor(policies, { action: "deploy", workflow: "release-app" })).toEqual({ decision: "ask" });
  });

  it("lets the strictest applicable policy win", () => {
    const policies = [policy("lax", { deploy: "allow" }), policy("careful", { deploy: "ask" }, ["release-app"])];

    expect(decideFor(policies, { action: "deploy", workflow: "release-app" })).toEqual({ decision: "ask", policy: "careful" });
    expect(decideFor(policies, { action: "deploy", workflow: "nightly-scan" })).toEqual({ decision: "allow", policy: "lax" });
  });
});
