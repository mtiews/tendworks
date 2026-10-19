import { toArtifact } from "./artifacts.js";
import type { Harness } from "./harness.js";

/**
 * The fake agent (harness `fake`): answers deterministically as its profile says,
 * without a sandbox or a model, and costs nothing. A resumed task only works for the
 * time that is left. Stands in for a real agent in tests and demos.
 */
export function createFakeHarness({ sleep }: { sleep: (ms: number) => Promise<void> }): Harness {
  return {
    async run({ taskId, profile, message, elapsedMs = 0 }, observer) {
      const { outcome = "completed", delaySeconds = 0, message: reply, artifacts = [] } = profile.spec.fake ?? {};
      observer.progress("working");
      const remainingMs = delaySeconds * 1_000 - elapsedMs;
      if (remainingMs > 0) await sleep(remainingMs);

      const cost = { amount: 0, currency: "USD" };
      if (outcome === "failed") {
        const text = reply ?? "the fake agent failed as configured";
        observer.record({ type: "error", message: text });
        return { state: "TASK_STATE_FAILED", message: text, cost };
      }
      const text = reply ?? "done";
      observer.record({ type: "message-chunk", text });
      observer.record({ type: "turn-ended", reason: "completed" });
      return {
        state: "TASK_STATE_COMPLETED",
        message: text,
        artifacts: [{ artifactId: `${taskId}/echo`, name: "echo", parts: message.parts }, ...artifacts.map((artifact) => toArtifact(taskId, artifact))],
        cost,
      };
    },
  };
}
