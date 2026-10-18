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
        - wait:
            listen:
              to:
                one:
                  with: { type: dev.tendworks.approval.decided }
`);

    expect(issues).toEqual(["/do/1/review/do/0/wait: unsupported task type 'listen' (supported: call, do)"]);
  });

  it("rejects a call type other than a2a", () => {
    const issues = issuesOf(`${header}
do:
  - fetch:
      call: http
      with: { method: get, endpoint: https://example.com }
`);

    expect(issues).toEqual(["/do/0/fetch: unsupported call type 'http' (supported: a2a)"]);
  });

  it("names a property the interpreter does not support", () => {
    const issues = issuesOf(`${header}
do:${implement}
      then: end
`);

    expect(issues).toEqual(["/do/0/implement: unsupported property 'then'"]);
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
