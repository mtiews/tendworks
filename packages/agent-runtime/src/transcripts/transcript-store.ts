import type { TranscriptEntry as Entries } from "@tendworks/shared";

/**
 * One entry of a transcript: what happened in an agent session, in the product-neutral
 * form of contracts/schemas/transcript-entry.schema.yaml.
 */
export type TranscriptEntry = Entries.TranscriptEntry;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An entry before the store gave it its position. */
export type UnnumberedEntry = DistributiveOmit<TranscriptEntry, "position">;

/** An entry as harnesses and the agent runtime record it; the runtime stamps the time, the store the position. */
export type TranscriptRecord = DistributiveOmit<TranscriptEntry, "position" | "time">;

/** The transcript of one task, open for appending. */
export interface Transcript {
  /** Where the transcript can be found; reported with the task. */
  readonly ref: string;
  /** Appends an entry at the next position and answers it as it was kept. */
  append(entry: UnnumberedEntry): Promise<TranscriptEntry>;
}

/**
 * Keeps transcripts of agent sessions outside the sandbox, so they outlive it.
 * Every task has one transcript; opening it again continues it. Entries are numbered
 * by their position from 0, in the order they were appended.
 *
 * @port
 */
export interface TranscriptStore {
  open(taskId: string): Transcript;
  /** All entries of a transcript in order, or undefined if there is none at `ref`. */
  read(ref: string): Promise<TranscriptEntry[] | undefined>;
}

const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertTaskId(taskId: string): void {
  if (!taskIdPattern.test(taskId) || taskId.includes("..")) throw new Error(`invalid task id ${JSON.stringify(taskId)}`);
}

/** Gives an entry its position. */
export const numbered = (entry: UnnumberedEntry, position: number): TranscriptEntry => ({ ...entry, position });

/** Transcripts in memory, for tests and for running without a volume. */
export function createInMemoryTranscriptStore(): TranscriptStore {
  const transcripts = new Map<string, TranscriptEntry[]>();
  return {
    open(taskId) {
      assertTaskId(taskId);
      const ref = `memory:${taskId}`;
      return {
        ref,
        async append(entry) {
          const entries = transcripts.get(ref) ?? [];
          const kept = numbered(structuredClone(entry), entries.length);
          entries.push(kept);
          transcripts.set(ref, entries);
          return structuredClone(kept);
        },
      };
    },
    async read(ref) {
      return structuredClone(transcripts.get(ref));
    },
  };
}
