import type { Policy as PolicyKind } from "@tendworks/shared";

export type Policy = PolicyKind.Policy;
export type PolicyDecision = PolicyKind.PolicyDecision;

/** A gated action a policy decides on. More actions (deploy, cost over budget) join later. */
export interface GatedAction {
  action: "merge";
}

/**
 * The policy decision function: whether a gated action may be performed right away
 * (`allow`) or an approval request decides first (`ask`). Pure, so it can be replaced
 * by a policy engine (OPA, CEL) behind the same signature.
 */
export function decide(policy: Policy, { action }: GatedAction): PolicyDecision {
  switch (action) {
    case "merge":
      return policy.spec.merge === "auto" ? "allow" : "ask";
  }
}

const STRICTNESS: Record<PolicyDecision, number> = { allow: 0, ask: 1 };

/**
 * Decides a gated action of a run by every policy that applies to the run's workflow
 * (a policy without `workflows` applies to all); the strictest decision wins, so adding
 * a policy can only make a gate stricter. `undefined` when no policy applies.
 */
export function decideFor(policies: Policy[], { workflow, ...action }: GatedAction & { workflow: string }): { decision: PolicyDecision; policy: string } | undefined {
  let strictest: { decision: PolicyDecision; policy: string } | undefined;
  for (const policy of policies) {
    if (policy.spec.workflows && !policy.spec.workflows.includes(workflow)) continue;
    const decision = decide(policy, action);
    if (!strictest || STRICTNESS[decision] > STRICTNESS[strictest.decision]) strictest = { decision, policy: policy.metadata.name };
  }
  return strictest;
}
