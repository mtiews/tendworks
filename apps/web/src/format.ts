import type { ControlPlane } from "@tendworks/shared";

type Run = ControlPlane.components["schemas"]["run"];
export type Cost = NonNullable<Run["steps"][number]["cost"]>;

/** `manual`, or `trigger <binding>: <owner>/<name>#<n>` (as `tend run list`); empty for runs recorded without an origin. */
export function formatOrigin(origin: Run["startedBy"]): string {
  if (!origin) return "";
  if (origin.kind === "manual") return "manual";
  return `trigger ${origin.binding}: ${origin.issue.repository}#${origin.issue.number}`;
}

/** `0.1234 USD`, at most four decimals, as `tend` shows costs. */
export const formatCost = ({ amount, currency }: Cost): string => `${Number(amount.toFixed(4))} ${currency}`;

/** Sums costs per currency, e.g. `0.52 USD`; empty without costs. */
export function totalCost(costs: Cost[]): string {
  const sums = new Map<string, number>();
  for (const { amount, currency } of costs) sums.set(currency, (sums.get(currency) ?? 0) + amount);
  return [...sums].map(([currency, amount]) => formatCost({ amount, currency })).join(", ");
}
