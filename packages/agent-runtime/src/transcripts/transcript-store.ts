/** One line of a transcript: what happened in an agent session, as a JSON object with a `type`. */
export type TranscriptEntry = { type: string } & Record<string, unknown>;

/** The transcript of one task, open for appending. */
export interface Transcript {
  /** Where the transcript can be found; reported with the task. */
  readonly ref: string;
  append(entry: TranscriptEntry): Promise<void>;
}

/**
 * Keeps transcripts of agent sessions outside the sandbox, so they outlive it.
 * Every task has one transcript; opening it again continues it.
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
          entries.push(structuredClone(entry));
          transcripts.set(ref, entries);
        },
      };
    },
    async read(ref) {
      return structuredClone(transcripts.get(ref));
    },
  };
}
