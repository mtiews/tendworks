import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileTranscriptStore, createInMemoryTranscriptStore } from "../index.js";
import { describeTranscriptStore } from "./transcript-store.suite.js";

describeTranscriptStore("in memory", () => createInMemoryTranscriptStore());
describeTranscriptStore("files", () => createFileTranscriptStore({ directory: mkdtempSync(join(tmpdir(), "tend-transcripts-")) }));

const time = "2026-10-19T10:00:00.000Z";

describe("file transcript store", () => {
  it("keeps transcripts readable and continues their positions for a new store on the same directory, e.g. after a restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tend-transcripts-"));
    const transcript = createFileTranscriptStore({ directory }).open("task-1");
    await transcript.append({ time, type: "message-chunk", text: "before" });

    const after = createFileTranscriptStore({ directory });
    await after.open("task-1").append({ time, type: "message-chunk", text: "after" });

    expect(await after.read(transcript.ref)).toEqual([
      { position: 0, time, type: "message-chunk", text: "before" },
      { position: 1, time, type: "message-chunk", text: "after" },
    ]);
  });

  it("refers to a transcript by a file URL", () => {
    const directory = mkdtempSync(join(tmpdir(), "tend-transcripts-"));

    expect(createFileTranscriptStore({ directory }).open("task-1").ref).toMatch(/^file:\/\/.*task-1\.jsonl$/);
  });
});
