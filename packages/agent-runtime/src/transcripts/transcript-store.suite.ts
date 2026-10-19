import { describe, expect, it } from "vitest";
import type { TranscriptStore, UnnumberedEntry } from "./transcript-store.js";

const time = "2026-10-19T10:00:00.000Z";
const chunk = (text: string): UnnumberedEntry => ({ time, type: "message-chunk", text });

/** What every transcript store must do, the file store and the in-memory fake alike. */
export function describeTranscriptStore(name: string, setup: () => TranscriptStore | Promise<TranscriptStore>) {
  describe(`transcript store: ${name}`, () => {
    it("reads back a task's entries in the order they were appended, numbered by their position from 0", async () => {
      const store = await setup();
      const transcript = store.open("task-1");

      await transcript.append(chunk("Say hello"));
      await transcript.append({ time, type: "tool-call", toolCallId: "tool-1", title: "Write hello.txt" });

      expect(await store.read(transcript.ref)).toEqual([
        { position: 0, time, type: "message-chunk", text: "Say hello" },
        { position: 1, time, type: "tool-call", toolCallId: "tool-1", title: "Write hello.txt" },
      ]);
    });

    it("answers an append with the entry as it was kept, position included", async () => {
      const store = await setup();
      const transcript = store.open("task-3");

      const appended = await Promise.all([transcript.append(chunk("a")), transcript.append(chunk("b"))]);

      expect(appended.map((entry) => entry.position)).toEqual([0, 1]);
      expect(appended[1]).toEqual({ position: 1, time, type: "message-chunk", text: "b" });
    });

    it("keeps the transcripts of different tasks apart", async () => {
      const store = await setup();
      const first = store.open("task-a");
      const second = store.open("task-b");

      await first.append(chunk("a"));
      await second.append(chunk("b"));

      expect(first.ref).not.toBe(second.ref);
      expect(await store.read(first.ref)).toEqual([{ position: 0, time, type: "message-chunk", text: "a" }]);
      expect(await store.read(second.ref)).toEqual([{ position: 0, time, type: "message-chunk", text: "b" }]);
    });

    it("continues a transcript that is opened again, after its last position", async () => {
      const store = await setup();
      await store.open("task-2").append(chunk("first"));

      const reopened = store.open("task-2");
      const appended = await reopened.append(chunk("second"));

      expect(appended.position).toBe(1);
      expect(await store.read(reopened.ref)).toEqual([
        { position: 0, time, type: "message-chunk", text: "first" },
        { position: 1, time, type: "message-chunk", text: "second" },
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
