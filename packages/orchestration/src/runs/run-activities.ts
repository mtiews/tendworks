import { RUN_ID, STEP_REFERENCE, TRANSCRIPT, type AgentTaskExecutor } from "../workflow/agent-task-executor.js";
import type { HttpExecutor } from "../workflow/http-executor.js";
import type { RunActivities } from "./execute-run.js";
import { runFinished, runStarted, stepChanged } from "./run-events.js";
import type { RunStore } from "./run-store.js";

export interface RunActivitiesOptions {
  store: RunStore;
  /** The A2A boundary to the agent runtime. */
  agents: AgentTaskExecutor;
  /** Makes the requests of `call: http` tasks. */
  http: HttpExecutor;
  now?: () => Date;
}

/** The side effects of executing a run: recording state and events, calling agents and endpoints. */
export function createRunActivities({ store, agents, http, now = () => new Date() }: RunActivitiesOptions): RunActivities {
  const timestamp = () => now().toISOString();
  return {
    async runStarted(run) {
      const time = timestamp();
      await store.updateRun(run.runId, { status: "running", startedAt: time }, [runStarted(run, time)]);
    },
    async recordStep(run, step) {
      const time = timestamp();
      await store.saveStep(
        run.runId,
        { ...step, startedAt: time, ...(step.status === "running" ? {} : { finishedAt: time }) },
        [stepChanged(run, step, time)],
      );
    },
    // The step names its task while the agent still works, so clients can follow it.
    sendMessage: (agent, request) =>
      agents.sendMessage(agent, request, {
        onTask: async ({ id, metadata }) => {
          const runId = request.metadata?.[RUN_ID];
          const reference = request.metadata?.[STEP_REFERENCE];
          if (typeof runId !== "string" || typeof reference !== "string") return;
          const transcript = metadata?.[TRANSCRIPT];
          await store.nameTask(runId, reference, { taskId: id, ...(typeof transcript === "string" ? { transcript } : {}) });
        },
      }),
    httpRequest: (request) => http.request(request),
    // The event carries the steps' artifacts from orchestration's own record of the run.
    async runFinished(run, outcome) {
      const time = timestamp();
      const artifacts = ((await store.get(run.runId))?.steps ?? []).flatMap((step) => step.artifacts ?? []);
      if (outcome.status === "completed") {
        await store.updateRun(run.runId, { status: "completed", output: outcome.output, finishedAt: time }, [
          runFinished(run, { status: "completed" }, artifacts, time),
        ]);
      } else {
        await store.updateRun(run.runId, { status: "failed", error: outcome.error!, finishedAt: time }, [
          runFinished(run, { status: "failed", error: outcome.error! }, artifacts, time),
        ]);
      }
    },
  };
}
