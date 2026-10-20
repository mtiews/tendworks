export const UNREACHABLE = "Cannot reach the platform. Is it running?";

/** The platform answered, but not with what was asked for (e.g. 404, 503). */
export class AnswerError extends Error {
  constructor(
    readonly status: number,
    readonly title: string | undefined,
    /** The problem's detail: why the platform refused, e.g. a request it found invalid. */
    readonly detail?: string,
  ) {
    super(title ? `${title} (${status})` : `The platform answered ${status}.`);
  }

  /** The platform's reason in its own words, `Title: detail`, e.g. for a refused form. */
  get reason(): string {
    return this.title && this.detail ? `${this.title}: ${this.detail}` : this.message;
  }
}

interface Result<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/**
 * The data of a call of the generated client; throws an error whose message the operator
 * can read: {@link UNREACHABLE} without an answer, an {@link AnswerError} for any other one.
 */
export async function answer<T>(call: Promise<Result<T>>): Promise<T> {
  let result: Result<T>;
  try {
    result = await call;
  } catch {
    throw new Error(UNREACHABLE);
  }
  if (result.data !== undefined) return result.data;
  const problem = result.error as { title?: unknown; detail?: unknown } | undefined;
  throw new AnswerError(result.response.status, typeof problem?.title === "string" ? problem.title : undefined, typeof problem?.detail === "string" ? problem.detail : undefined);
}
