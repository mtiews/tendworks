import type { Harness } from "./harness.js";

/**
 * The fake agent (harness `fake`): answers deterministically as its profile says,
 * without a sandbox or a model, and costs nothing. Stands in for a real agent in tests
 * and demos.
 */
export function createFakeHarness({ sleep }: { sleep: (ms: number) => Promise<void> }): Harness {
  return {
    async run({ taskId, profile, message }, observer) {
      const { outcome = "completed", delaySeconds = 0, message: reply } = profile.spec.fake ?? {};
      observer.progress("working");
      if (delaySeconds > 0) await sleep(delaySeconds * 1_000);

      const cost = { amount: 0, currency: "USD" };
      if (outcome === "failed") {
        const text = reply ?? "the fake agent failed as configured";
        observer.record({ type: "agent-message", text });
        return { state: "TASK_STATE_FAILED", message: text, cost };
      }
      const text = reply ?? "done";
      observer.record({ type: "agent-message", text });
      return {
        state: "TASK_STATE_COMPLETED",
        message: text,
        artifacts: [{ artifactId: `${taskId}/echo`, name: "echo", parts: message.parts }],
        cost,
      };
    },
  };
}
