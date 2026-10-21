/*
 * How clients (the `tend` CLI, the web UI) show costs and run origins, so both say it the
 * same way. Typed structurally on the contract's shapes, without depending on them.
 */

/** A cost as the contract carries it, e.g. of a step or a chat. */
export interface Cost {
  amount: number;
  currency: string;
}

/** What started a run, as the contract's `runOrigin` carries it. */
export type RunOrigin = { kind: "manual" } | { kind: "trigger"; binding: string; issue: { repository: string; number: number; url: string } };

/** `0.1234 USD`: at most four decimals. */
export const formatCost = ({ amount, currency }: Cost): string => `${Number(amount.toFixed(4))} ${currency}`;

/** Sums costs per currency, e.g. `0.52 USD` or `0.5 USD, 1 EUR`; empty without costs. */
export function totalCost(costs: readonly Cost[]): string {
  const sums = new Map<string, number>();
  for (const { amount, currency } of costs) sums.set(currency, (sums.get(currency) ?? 0) + amount);
  return [...sums].map(([currency, amount]) => formatCost({ amount, currency })).join(", ");
}

/**
 * `manual`, or `trigger <binding>: <owner>/<name>#<n>`, with the issue's address after it
 * when `url` is set; empty for runs recorded without an origin.
 */
export function formatOrigin(origin: RunOrigin | undefined, { url = false }: { url?: boolean } = {}): string {
  if (!origin) return "";
  if (origin.kind === "manual") return "manual";
  return `trigger ${origin.binding}: ${origin.issue.repository}#${origin.issue.number}${url ? ` (${origin.issue.url})` : ""}`;
}
