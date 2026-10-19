/** What a producer knows about the event it emits; the rest of the envelope is fixed. */
export interface EventEnvelopeFields {
  /** Unique per source; deterministic ids make a repeated write recognisable. */
  id: string;
  /** URI reference of the producing domain, e.g. `/tendworks/orchestration`. */
  source: string;
  subject: string;
  time: string;
  /** The run the event belongs to. */
  runId: string;
  /** W3C trace context of the run the event belongs to. */
  traceparent: string;
  /** The step the event belongs to (its reference in the workflow), if any. */
  stepId?: string;
}

/**
 * The envelope every Tendworks event shares (contracts/events/cloudevent.schema.yaml):
 * a CloudEvent 1.0 in structured JSON mode with the extension attributes `runid`,
 * `stepid` and `traceparent`. Producers add `type` and `data`.
 */
export function eventEnvelope({ id, source, subject, time, runId, traceparent, stepId }: EventEnvelopeFields) {
  return {
    specversion: "1.0" as const,
    id,
    source,
    subject,
    time,
    datacontenttype: "application/json" as const,
    runid: runId,
    traceparent,
    ...(stepId === undefined ? {} : { stepid: stepId }),
  };
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** A W3C traceparent that starts a new trace, for work no caller traces yet. */
export function newTraceparent(): string {
  return `00-${hex(16)}-${hex(8)}-01`;
}

/** Whether `value` is a W3C traceparent (version 00) with a non-zero trace and parent id. */
export function isTraceparent(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = TRACEPARENT.exec(value);
  return match !== null && !/^0+$/.test(match[1]!) && !/^0+$/.test(match[2]!);
}

/** The trace id of a traceparent: what all events of one trace share. */
export function traceIdOf(traceparent: string): string | undefined {
  return TRACEPARENT.exec(traceparent)?.[1];
}

function hex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
