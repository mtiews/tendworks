import type { AgentTaskExecutor } from "../workflow/agent-task-executor.js";
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
    sendMessage: (agent, request) => agents.sendMessage(agent, request),
    httpRequest: (request) => http.request(request),
    async runFinished(run, outcome) {
      const time = timestamp();
      if (outcome.status === "completed") {
        await store.updateRun(run.runId, { status: "completed", output: outcome.output, finishedAt: time }, [
          runFinished(run, { status: "completed" }, time),
        ]);
      } else {
        await store.updateRun(run.runId, { status: "failed", error: outcome.error!, finishedAt: time }, [
          runFinished(run, { status: "failed", error: outcome.error! }, time),
        ]);
      }
    },
  };
}
