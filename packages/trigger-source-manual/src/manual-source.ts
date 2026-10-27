import type { TriggerBinding } from "@tendworks/shared";
import type { TriggerSource } from "@tendworks/trigger-gateway/source";

/**
 * Trigger source of kind `manual` (ADR 0028): has no schedule, so the gateway asks it only
 * when the binding is fired. Each firing is one new item, keyed by the time of the firing,
 * so firing again starts new runs.
 */
export function createManualSource(_settings: TriggerBinding.ManualTrigger): TriggerSource {
  return {
    async items({ at }) {
      return [{ key: at.toISOString(), title: "started by hand" }];
    },
  };
}
