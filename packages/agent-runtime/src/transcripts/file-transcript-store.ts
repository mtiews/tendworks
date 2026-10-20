import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertTaskId, numbered, type TranscriptEntry, type TranscriptStore } from "./transcript-store.js";

export interface FileTranscriptStoreOptions {
  /** Directory for the transcripts, e.g. a volume of the worker. One JSON Lines file per task. */
  directory: string;
}

/**
 * Transcripts as JSON Lines files (`<taskId>.jsonl`), referred to by `file://` URL. An
 * entry's position is its line number from 0.
 */
export function createFileTranscriptStore({ directory }: FileTranscriptStoreOptions): TranscriptStore {
  const ready = mkdir(directory, { recursive: true });
  // Appends to one file are chained, so entries keep their order and positions.
  const queues = new Map<string, Promise<unknown>>();
  // Entries per file, counted from the file on the first append of this process.
  const counts = new Map<string, number>();

  const lines = async (file: string): Promise<string[] | undefined> => {
    try {
      return (await readFile(file, "utf8")).split("\n").filter((line) => line.trim() !== "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };

  return {
    open(taskId) {
      assertTaskId(taskId);
      const file = join(directory, `${taskId}.jsonl`);
      return {
        ref: pathToFileURL(file).href,
        append(entry) {
          const next = (queues.get(file) ?? ready).then(async () => {
            const position = counts.get(file) ?? (await lines(file))?.length ?? 0;
            const kept = numbered(entry, position);
            await appendFile(file, `${JSON.stringify(kept)}\n`, "utf8");
            counts.set(file, position + 1);
            return kept;
          });
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
      return (await lines(file))?.map((line, position) => ({ ...(JSON.parse(line) as TranscriptEntry), position }));
    },
  };
}
