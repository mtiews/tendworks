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
