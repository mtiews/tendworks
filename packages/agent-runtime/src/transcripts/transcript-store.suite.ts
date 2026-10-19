import { describe, expect, it } from "vitest";
import type { TranscriptStore } from "./transcript-store.js";

/** What every transcript store must do, the file store and the in-memory fake alike. */
export function describeTranscriptStore(name: string, setup: () => TranscriptStore | Promise<TranscriptStore>) {
  describe(`transcript store: ${name}`, () => {
    it("reads back a task's entries in the order they were appended", async () => {
      const store = await setup();
      const transcript = store.open("task-1");

      await transcript.append({ type: "task", text: "Say hello" });
      await transcript.append({ type: "update", update: { text: "Hello" } });

      expect(await store.read(transcript.ref)).toEqual([
        { type: "task", text: "Say hello" },
        { type: "update", update: { text: "Hello" } },
      ]);
    });

    it("keeps the transcripts of different tasks apart", async () => {
      const store = await setup();
      const first = store.open("task-a");
      const second = store.open("task-b");

      await first.append({ type: "task", text: "a" });
      await second.append({ type: "task", text: "b" });

      expect(first.ref).not.toBe(second.ref);
      expect(await store.read(first.ref)).toEqual([{ type: "task", text: "a" }]);
    });

    it("continues a transcript that is opened again", async () => {
      const store = await setup();
      await store.open("task-2").append({ type: "task", text: "first" });

      const reopened = store.open("task-2");
      await reopened.append({ type: "task", text: "second" });

      expect(await store.read(reopened.ref)).toEqual([
        { type: "task", text: "first" },
        { type: "task", text: "second" },
      ]);
    });

    it("answers undefined for a reference it does not know", async () => {
      const store = await setup();

      expect(await store.read("nothing-here")).toBeUndefined();
    });

    it("refuses task ids that could address something outside the store", async () => {
      const store = await setup();

      expect(() => store.open("../escape")).toThrow("invalid task id");
    });
  });
}
