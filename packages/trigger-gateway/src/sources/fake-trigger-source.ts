import type { TriggerBinding } from "@tendworks/shared";
import type { FakeTriggerSettings, TriggerSource } from "./trigger-source.js";

/**
 * Trigger source of the test-only kind `fake`: serves the listed items to every workspace
 * at every interval, so the gateway fires without an account anywhere. Not part of the
 * binding schema and not deployed with the platform: tests register it with the gateway
 * themselves and build their bindings with {@link fakeTriggerBinding}.
 */
export function createFakeTriggerSource(settings: FakeTriggerSettings): TriggerSource {
  return {
    schedule: { every: structuredClone(settings.every) },
    async items() {
      return structuredClone(settings.items ?? []);
    },
  };
}

/**
 * A trigger binding of the test-only kind `fake`, which the binding schema (and so its
 * type) does not know: the one place a test binding leaves the schema's trigger kinds.
 */
export function fakeTriggerBinding(
  metadata: TriggerBinding.TriggerBinding["metadata"],
  { trigger, ...spec }: Omit<TriggerBinding.TriggerBinding["spec"], "trigger"> & { trigger: FakeTriggerSettings },
): TriggerBinding.TriggerBinding {
  const binding = { apiVersion: "tendworks.dev/v1", kind: "TriggerBinding", metadata, spec: { ...spec, trigger: { fake: trigger } } };
  return binding as unknown as TriggerBinding.TriggerBinding;
}
