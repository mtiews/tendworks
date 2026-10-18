import type { A2A, AgentProfile } from "@tendworks/shared";

/**
 * The fake agent (harness `fake`): answers deterministically as its profile says,
 * without a sandbox or a model. Stands in for a real agent in tests and demos.
 */
export async function answerAsFakeAgent(
  config: AgentProfile.FakeAgent,
  request: A2A.SendMessageRequest,
  { taskId, sleep }: { taskId: string; sleep: (ms: number) => Promise<void> },
): Promise<A2A.Task> {
  const { outcome = "completed", delaySeconds = 0 } = config;
  if (delaySeconds > 0) await sleep(delaySeconds * 1_000);

  const reply = (text: string): A2A.Message => ({ messageId: `${taskId}/status`, taskId, role: "ROLE_AGENT", parts: [{ text }] });
  const base = {
    id: taskId,
    ...(request.message.contextId === undefined ? {} : { contextId: request.message.contextId }),
    history: [request.message],
  };
  if (outcome === "failed") {
    return {
      ...base,
      status: { state: "TASK_STATE_FAILED", message: reply(config.message ?? "the fake agent failed as configured"), timestamp: new Date().toISOString() },
    };
  }
  return {
    ...base,
    status: { state: "TASK_STATE_COMPLETED", message: reply(config.message ?? "done"), timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: `${taskId}/echo`, name: "echo", parts: request.message.parts }],
  };
}
