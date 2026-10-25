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
export type RunOrigin = { kind: "manual" } | { kind: "trigger"; binding: string; workspace?: string; item: { key: string; title: string; url?: string } };

/** When a trigger is checked, as the contract's `TriggerSchedule` carries it. */
export type Schedule = { cron: string } | { every: { days?: number; hours?: number; minutes?: number; seconds?: number } };

/** `0.1234 USD`: at most four decimals. */
export const formatCost = ({ amount, currency }: Cost): string => `${Number(amount.toFixed(4))} ${currency}`;

/** Sums costs per currency, e.g. `0.52 USD` or `0.5 USD, 1 EUR`; empty without costs. */
export function totalCost(costs: readonly Cost[]): string {
  const sums = new Map<string, number>();
  for (const { amount, currency } of costs) sums.set(currency, (sums.get(currency) ?? 0) + amount);
  return [...sums].map(([currency, amount]) => formatCost({ amount, currency })).join(", ");
}

/** `every 5m30s` for an interval, `cron 0 2 * * *` for a cron expression. */
export function formatSchedule(schedule: Schedule): string {
  if ("cron" in schedule) return `cron ${schedule.cron}`;
  const units = [["days", "d"], ["hours", "h"], ["minutes", "m"], ["seconds", "s"]] as const;
  return `every ${units.map(([unit, suffix]) => (schedule.every[unit] ? `${schedule.every[unit]}${suffix}` : "")).join("") || "0s"}`;
}

/**
 * `manual`, or `trigger <binding> in <workspace>: <item key>` (without ` in …` for a
 * binding without workspaces), with the item's link after it when `url` is set and the
 * item has one; empty for a run without an origin.
 */
export function formatOrigin(origin: RunOrigin | undefined, { url = false }: { url?: boolean } = {}): string {
  if (!origin) return "";
  if (origin.kind === "manual") return "manual";
  const workspace = origin.workspace === undefined ? "" : ` in ${origin.workspace}`;
  return `trigger ${origin.binding}${workspace}: ${origin.item.key}${url && origin.item.url ? ` (${origin.item.url})` : ""}`;
}

/** A chat's title (its first message) on one line, cut after `max` characters with an ellipsis. */
export function shortTitle(title: string, max = 60): string {
  const line = title.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}
