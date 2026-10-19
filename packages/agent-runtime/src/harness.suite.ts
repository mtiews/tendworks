import type { A2A, AgentProfile } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import type { Harness, HarnessObserver } from "./harness.js";
import type { TranscriptEntry } from "./transcripts/transcript-store.js";

export interface HarnessSuiteContext {
  harness: Harness;
  /** A profile under which the harness completes a simple task. */
  profile: AgentProfile.AgentProfile;
  /** What the agent answers to that task. */
  reply: string;
}

/**
 * What every harness must do behind the harness port, the fake agent and Claude Code
 * over ACP alike, so the agent runtime can rely on it without knowing which one runs.
 */
export function describeHarness(name: string, setup: () => HarnessSuiteContext | Promise<HarnessSuiteContext>) {
  describe(`harness: ${name}`, () => {
    const message: A2A.Message = { messageId: "m-1", role: "ROLE_USER", parts: [{ text: "Say hello" }] };

    const observe = () => {
      const entries: TranscriptEntry[] = [];
      const progress: string[] = [];
      const observer: HarnessObserver = {
        record: (entry) => entries.push(entry),
        progress: (text) => progress.push(text),
        saveSession: async () => {},
      };
      return { observer, entries, progress };
    };

    it("completes a simple task with the agent's answer", async () => {
      const { harness, profile, reply } = await setup();

      const result = await harness.run({ taskId: "task-1", profile, message }, observe().observer);

      expect(result).toMatchObject({ state: "TASK_STATE_COMPLETED", message: reply });
    });

    it("records what the agent said in the transcript", async () => {
      const { harness, profile, reply } = await setup();
      const { observer, entries } = observe();

      await harness.run({ taskId: "task-2", profile, message }, observer);

      expect(JSON.stringify(entries)).toContain(reply);
    });

    it("reports progress while it works", async () => {
      const { harness, profile } = await setup();
      const { observer, progress } = observe();

      await harness.run({ taskId: "task-3", profile, message }, observer);

      expect(progress.length).toBeGreaterThan(0);
    });

    it("reports what the session cost", async () => {
      const { harness, profile } = await setup();

      const result = await harness.run({ taskId: "task-4", profile, message }, observe().observer);

      expect(result.cost).toEqual({ amount: expect.any(Number), currency: "USD" });
    });
  });
}
