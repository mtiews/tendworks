import { describe, expect, it } from "vitest";
import { eventEnvelope, isTraceparent, newTraceparent, traceIdOf } from "./index.js";

const PARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

describe("event envelope", () => {
  it("carries the run and its trace as CloudEvent extension attributes", () => {
    expect(
      eventEnvelope({ id: "r1:run.started", source: "/tendworks/orchestration", subject: "runs/r1", time: "2026-10-19T08:00:00.000Z", runId: "r1", traceparent: PARENT }),
    ).toEqual({
      specversion: "1.0",
      id: "r1:run.started",
      source: "/tendworks/orchestration",
      subject: "runs/r1",
      time: "2026-10-19T08:00:00.000Z",
      datacontenttype: "application/json",
      runid: "r1",
      traceparent: PARENT,
    });
  });

  it("names the step when the event belongs to one", () => {
    const envelope = eventEnvelope({ id: "x", source: "/s", subject: "runs/r1", time: "2026-10-19T08:00:00.000Z", runId: "r1", traceparent: PARENT, stepId: "/do/0/a" });

    expect(envelope.stepid).toBe("/do/0/a");
  });

  it("carries no run for an event that belongs to none, e.g. of a chat", () => {
    const envelope = eventEnvelope({ id: "c1:chat.started", source: "/tendworks/agent-runtime", subject: "chats/c1", time: "2026-10-19T08:00:00.000Z", traceparent: PARENT });

    expect(envelope).toStrictEqual({
      specversion: "1.0",
      id: "c1:chat.started",
      source: "/tendworks/agent-runtime",
      subject: "chats/c1",
      time: "2026-10-19T08:00:00.000Z",
      datacontenttype: "application/json",
      traceparent: PARENT,
    });
  });
});

describe("trace context", () => {
  it("starts a new trace with a valid traceparent each time", () => {
    const first = newTraceparent();
    const second = newTraceparent();

    expect(isTraceparent(first)).toBe(true);
    expect(traceIdOf(first)).not.toBe(traceIdOf(second));
  });

  it("reads the trace id of a traceparent", () => {
    expect(traceIdOf(PARENT)).toBe("0af7651916cd43dd8448eb211c80319c");
  });

  it("rejects values that are not a version 00 traceparent", () => {
    expect(isTraceparent("00-00000000000000000000000000000000-b7ad6b7169203331-01")).toBe(false);
    expect(isTraceparent("01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")).toBe(false);
    expect(isTraceparent("trace")).toBe(false);
    expect(isTraceparent(undefined)).toBe(false);
  });
});
