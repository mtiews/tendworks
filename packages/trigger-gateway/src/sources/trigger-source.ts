import type { SecretResolver } from "@tendworks/platform";
import type { TriggerBinding, Workspace } from "@tendworks/shared";

// The trigger source port (ADR 0023). This file is the only part of the trigger gateway
// that trigger source packages (packages/trigger-source-*) may import, through the
// `@tendworks/trigger-gateway/source` entry point.

/** What a source reports: a stable key, a title, a link, and whatever else it knows. */
export type TriggerItem = TriggerBinding.TriggerItem;
/** When the gateway checks a source: a cron expression or an interval. */
export type TriggerSchedule = TriggerBinding.TriggerSchedule;

/** One check of a source, for one workspace of the binding or for none. */
export interface SourceCheck {
  /** The scheduled execution the check belongs to. */
  at: Date;
  /** The workspace the items are asked for; absent for a binding without workspaces. */
  workspace?: Workspace.Workspace;
}

/**
 * A trigger source: the gateway asks it at the executions of its schedule for the items
 * of each workspace, and starts one run per new (workspace, item). Deduplication is the
 * gateway's job, so a source may report the same item at every check.
 *
 * @port
 */
export interface TriggerSource {
  /** When the gateway checks this source. */
  readonly schedule: TriggerSchedule;
  /** The items at this check. Rejects when the source cannot be asked; the message names secrets, never values. */
  items(check: SourceCheck): Promise<TriggerItem[]>;
}

/** What every source gets from the platform. */
export interface TriggerSourceContext {
  /** Resolves secret references: only platform secrets (ADR 0008). */
  secrets: SecretResolver;
  /** The workspaces the binding names, in its order; empty for a binding without workspaces. */
  workspaces: readonly Workspace.Workspace[];
}

/**
 * Creates the source of one binding from its settings, which the binding schema has
 * validated, when the platform starts. Throws with the reason when the source cannot serve
 * the binding (e.g. a workspace of a kind it cannot read), so the platform refuses the
 * configuration instead of failing every check.
 */
export type TriggerSourceFactory<Settings> = (settings: Settings, context: TriggerSourceContext) => TriggerSource;

/** Settings of the test-only trigger kind `fake` (`createFakeTriggerSource`): the interval and the items it serves. */
export interface FakeTriggerSettings {
  every: TriggerBinding.Duration;
  items?: TriggerItem[];
}

/**
 * The settings of each trigger kind, by kind: the kinds of the binding schema
 * (`TriggerBinding.Trigger`), plus the test-only kind `fake`, which the schema refuses.
 */
export type TriggerSettings = { [K in keyof TriggerBinding.Trigger]-?: Exclude<TriggerBinding.Trigger[K], undefined> } & { fake: FakeTriggerSettings };

/** A trigger kind (`schedule`, …). */
export type TriggerKind = keyof TriggerSettings;

/**
 * The trigger sources deployed with the platform: for a kind, at most one factory, taking
 * that kind's settings. A binding of a kind without a factory stops the start.
 */
export type TriggerSources = { readonly [K in TriggerKind]?: TriggerSourceFactory<TriggerSettings[K]> };
