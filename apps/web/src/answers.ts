export const UNREACHABLE = "Cannot reach the platform. Is it running?";

/** The platform answered, but not with what was asked for (e.g. 404, 503). */
export class AnswerError extends Error {
  constructor(
    readonly status: number,
    title: string | undefined,
  ) {
    super(title ? `${title} (${status})` : `The platform answered ${status}.`);
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
  const problem = result.error as { title?: unknown } | undefined;
  throw new AnswerError(result.response.status, typeof problem?.title === "string" ? problem.title : undefined);
}
