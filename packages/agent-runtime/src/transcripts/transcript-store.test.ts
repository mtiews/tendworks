import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileTranscriptStore, createInMemoryTranscriptStore } from "../index.js";
import { describeTranscriptStore } from "./transcript-store.suite.js";

describeTranscriptStore("in memory", () => createInMemoryTranscriptStore());
describeTranscriptStore("files", () => createFileTranscriptStore({ directory: mkdtempSync(join(tmpdir(), "tend-transcripts-")) }));

describe("file transcript store", () => {
  it("keeps transcripts readable for a new store on the same directory, e.g. after a restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tend-transcripts-"));
    const transcript = createFileTranscriptStore({ directory }).open("task-1");
    await transcript.append({ type: "task", text: "Say hello" });

    expect(await createFileTranscriptStore({ directory }).read(transcript.ref)).toEqual([{ type: "task", text: "Say hello" }]);
  });

  it("refers to a transcript by a file URL", () => {
    const directory = mkdtempSync(join(tmpdir(), "tend-transcripts-"));

    expect(createFileTranscriptStore({ directory }).open("task-1").ref).toMatch(/^file:\/\/.*task-1\.jsonl$/);
  });
});
