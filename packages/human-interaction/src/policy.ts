import type { Policy as PolicyKind } from "@tendworks/shared";

export type Policy = PolicyKind.Policy;
export type PolicyDecision = PolicyKind.PolicyDecision;

const STRICTNESS: Record<PolicyDecision, number> = { allow: 0, ask: 1 };

/**
 * Decides a human step's action by every policy that applies to the run's workflow (a
 * policy without `workflows` applies to all) and names the action; the strictest
 * decision wins, so adding a policy can only make a step stricter. Without an applicable
 * policy the platform asks. Pure, so a policy engine (OPA, CEL) can replace it behind the
 * same signature.
 */
export function decideFor(policies: Policy[], { action, workflow }: { action: string; workflow: string }): { decision: PolicyDecision; policy?: string } {
  let strictest: { decision: PolicyDecision; policy: string } | undefined;
  for (const policy of policies) {
    if (policy.spec.workflows && !policy.spec.workflows.includes(workflow)) continue;
    const decision = policy.spec.actions[action];
    if (decision === undefined) continue;
    if (!strictest || STRICTNESS[decision] > STRICTNESS[strictest.decision]) strictest = { decision, policy: policy.metadata.name };
  }
  return strictest ?? { decision: "ask" };
}
