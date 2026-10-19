import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertTaskId, type TranscriptEntry, type TranscriptStore } from "./transcript-store.js";

export interface FileTranscriptStoreOptions {
  /** Directory for the transcripts, e.g. a volume of the worker. One JSON Lines file per task. */
  directory: string;
}

/** Transcripts as JSON Lines files (`<taskId>.jsonl`), referred to by `file://` URL. */
export function createFileTranscriptStore({ directory }: FileTranscriptStoreOptions): TranscriptStore {
  const ready = mkdir(directory, { recursive: true });
  // Appends to one file are chained, so entries keep their order.
  const queues = new Map<string, Promise<void>>();

  return {
    open(taskId) {
      assertTaskId(taskId);
      const file = join(directory, `${taskId}.jsonl`);
      return {
        ref: pathToFileURL(file).href,
        append(entry) {
          const next = (queues.get(file) ?? ready.then(() => {})).then(() => appendFile(file, `${JSON.stringify(entry)}\n`, "utf8"));
          queues.set(file, next.catch(() => {}));
          return next;
        },
      };
    },
    async read(ref) {
      let file: string;
      try {
        file = fileURLToPath(ref);
      } catch {
        return undefined;
      }
      await queues.get(file);
      try {
        const text = await readFile(file, "utf8");
        return text
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as TranscriptEntry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
  };
}
