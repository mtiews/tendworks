import type { TriggerBinding } from "@tendworks/shared";
import type { TriggerSource } from "./trigger-source.js";

/**
 * Trigger source of kind `fake`: serves the listed items to every workspace at every
 * interval, so the platform fires without an account anywhere. For tests and demos.
 */
export function createFakeTriggerSource(settings: TriggerBinding.FakeTrigger): TriggerSource {
  return {
    schedule: { every: structuredClone(settings.every) },
    async items() {
      return structuredClone(settings.items ?? []);
    },
  };
}
