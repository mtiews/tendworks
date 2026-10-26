import type { ReactNode } from "react";

/*
 * States as pills (ADR 0027): one color per state, the same everywhere, so "failed" or
 * "waiting" reads the same on a run, a notification or a chat. Words, never color alone.
 */

export type Tone = "ok" | "running" | "warn" | "error" | "neutral";

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

/** A neutral label for a kind or a name, e.g. a trigger's source or a workspace's kind. */
export function Chip({ children }: { children: ReactNode }) {
  return <span className="chip">{children}</span>;
}

const STATES: Record<string, Tone> = {
  // runs, steps and chats
  completed: "ok",
  succeeded: "ok",
  running: "running",
  working: "running",
  pending: "neutral",
  waiting: "warn",
  "input-required": "neutral",
  failed: "error",
  ended: "neutral",
  // approval requests
  decided: "ok",
  // events of notifications and subscriptions
  "run.started": "running",
  "run.completed": "ok",
  "run.failed": "error",
  "approval.requested": "warn",
  "platform.degraded": "error",
  "platform.recovered": "ok",
};

/** The tone of a status or an event type; an unknown one is neutral. */
export const toneOf = (state: string): Tone => STATES[state] ?? "neutral";

/** A status or an event type as its pill. */
export function StatePill({ state, children }: { state: string; children?: ReactNode }) {
  return <Pill tone={toneOf(state)}>{children ?? state}</Pill>;
}
