import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { validateWorkflow, WorkflowValidationError } from "../index.js";

const header = `document: { dsl: '1.0.3', namespace: test, name: wf, version: '0.1.0' }\n`;

const implement = `
  - implement:
      call: a2a
      with:
        method: message/send
        agentCard: { endpoint: agent://developer }
        parameters:
          message:
            parts: [{ kind: text, text: build it }]`;

function issuesOf(yaml: string): string[] {
  try {
    validateWorkflow(parse(yaml));
  } catch (error) {
    if (error instanceof WorkflowValidationError) return error.issues;
    throw error;
  }
  throw new Error("expected the workflow to be rejected");
}

describe("validateWorkflow", () => {
  it("rejects a task type the interpreter does not support", () => {
    const issues = issuesOf(`${header}
do:${implement}
  - review:
      do:
        - pause:
            wait: { minutes: 5 }
`);

    expect(issues).toEqual(["/do/1/review/do/0/pause: unsupported task type 'wait' (supported: call, do, switch, listen)"]);
  });

  it("rejects a call type other than a2a and http", () => {
    const issues = issuesOf(`${header}
do:
  - fetch:
      call: grpc
      with: { proto: { endpoint: https://example.com/a.proto }, service: { name: S, host: example.com }, method: M }
`);

    expect(issues).toEqual(["/do/0/fetch: unsupported call type 'grpc' (supported: a2a, http)"]);
  });

  it("accepts an http call with a literal or computed endpoint and a body", () => {
    const definition = validateWorkflow(
      parse(`${header}
do:
  - merge:
      call: http
      with:
        method: post
        endpoint: '\${ $runtime.metadata.controlPlaneUrl + "/deployments" }'
        headers: { x-request: '\${ .id }' }
        body: { pullRequest: '\${ .pullRequest }', policy: careful }
  - ping:
      call: http
      with: { method: get, endpoint: https://example.com/ping }
`),
    );

    expect(definition.do).toHaveLength(2);
  });

  it("names the http call arguments the interpreter does not support", () => {
    const issues = issuesOf(`${header}
do:
  - fetch:
      call: http
      with: { method: get, endpoint: example.com, output: raw }
`);

    expect(issues).toEqual(expect.arrayContaining(["/do/0/fetch/with: unsupported property 'output'"]));
    expect(issues.some((issue) => issue.startsWith("/do/0/fetch/with/endpoint:"))).toBe(true);
  });

  it("names a property the interpreter does not support", () => {
    const issues = issuesOf(`${header}
do:${implement}
      timeout: { after: { minutes: 5 } }
`);

    expect(issues).toEqual(["/do/0/implement: unsupported property 'timeout'"]);
  });

  it("lists every issue of an invalid call", () => {
    const issues = issuesOf(`
document: { dsl: '1.0.0', namespace: test, name: wf, version: '0.1.0' }
do:
  - implement:
      call: a2a
      with:
        method: message/stream
        agentCard: { endpoint: developer }
        parameters:
          message:
            parts: [{ kind: file, text: build it }]
`);

    expect(issues).toEqual([
      "/document/dsl: must be '1.0.3'",
      "/do/0/implement/with/method: must be 'message/send'",
      '/do/0/implement/with/agentCard/endpoint: must match pattern "^agent://[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$"',
      "/do/0/implement/with/parameters/message/parts/0/kind: must be 'text'",
    ]);
  });

  it("returns a supported workflow unchanged", () => {
    const definition = parse(`${header}do:${implement}`);

    expect(validateWorkflow(definition)).toBe(definition);
  });
});
