import { readServerSentEvents } from "@tendworks/platform";
import { contractSchema, describeErrors, readContract, type Document } from "./contracts.js";

/*
 * Guards a fetch handler with its OpenAPI contract (contracts/openapi/<name>.yaml), in
 * process: every request must address a documented operation, every response must have
 * a documented status and a body its schema allows. A request the contract forbids may
 * only be answered with a client error, so a client that sends one, or a server that
 * accepts one, fails the test. The contract records which documented responses were
 * exercised, so a test file can prove it covered the whole contract.
 */

export class ContractViolation extends Error {
  override name = "ContractViolation";
}

type Handler = (request: Request) => Promise<Response>;

interface Parameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  pointer: string;
}

interface Operation {
  method: string;
  template: string;
  pattern: RegExp;
  pointer: string;
  parameters: Parameter[];
  requestBody: { required?: boolean; content: Record<string, unknown> } | undefined;
  responses: Record<string, { content?: Record<string, unknown> }>;
}

const METHODS = ["get", "put", "post", "delete", "patch"] as const;

/** A JSON pointer segment, URI-encoded for use in a fragment. */
const segment = (key: string) => encodeURIComponent(key.replaceAll("~", "~0").replaceAll("/", "~1"));

export interface OpenApiContract {
  /** Wraps `handler` so every exchange is checked against the contract. */
  guard(handler: Handler): Handler;
  /** Documented responses (`METHOD /path status`) no guarded exchange produced yet. */
  unexercised(): string[];
  /**
   * Every violation the guards threw so far. A guard inside a client may have its
   * violation caught and turned into another answer (e.g. a 503), so check this too.
   */
  violations(): string[];
}

export function openApiContract(name: string): OpenApiContract {
  const file = `openapi/${name}.yaml`;
  const document = readContract(file);
  const resolve = <T>(node: unknown): T => {
    let current = node as { $ref?: string };
    while (typeof current?.$ref === "string" && current.$ref.startsWith("#/")) {
      current = current.$ref
        .slice(2)
        .split("/")
        .reduce<unknown>((at, key) => (at as Document)[key.replaceAll("~1", "/").replaceAll("~0", "~")], document) as { $ref?: string };
    }
    return current as T;
  };
  /** Where a parameter's own definition is: behind its local `$ref`, if it has one. */
  const parameterPointer = (parameter: unknown, at: string): string => {
    const ref = (parameter as { $ref?: unknown }).$ref;
    return typeof ref === "string" && ref.startsWith("#/") ? ref : at;
  };

  const operations: Operation[] = [];
  for (const [template, item] of Object.entries((document.paths ?? {}) as Record<string, Document>)) {
    const itemPointer = `#/paths/${segment(template)}`;
    const shared = ((item.parameters ?? []) as unknown[]).map((parameter, index) => ({
      ...resolve<Omit<Parameter, "pointer">>(parameter),
      pointer: parameterPointer(parameter, `${itemPointer}/parameters/${index}`),
    }));
    for (const method of METHODS) {
      const operation = item[method] as Document | undefined;
      if (!operation) continue;
      const pointer = `${itemPointer}/${method}`;
      const own = ((operation.parameters ?? []) as unknown[]).map((parameter, index) => ({
        ...resolve<Omit<Parameter, "pointer">>(parameter),
        pointer: parameterPointer(parameter, `${pointer}/parameters/${index}`),
      }));
      const names = new Set(own.map((parameter) => `${parameter.in}:${parameter.name}`));
      operations.push({
        method: method.toUpperCase(),
        template,
        pattern: new RegExp(`^${template.replace(/\{[^}]+\}/g, "([^/]+)")}$`),
        pointer,
        parameters: [...shared.filter((parameter) => !names.has(`${parameter.in}:${parameter.name}`)), ...own],
        requestBody: operation.requestBody ? resolve(operation.requestBody) : undefined,
        responses: Object.fromEntries(Object.entries(operation.responses as Document).map(([status, response]) => [status, resolve(response)])),
      });
    }
  }

  const exercised = new Set<string>();
  const violations: string[] = [];
  const label = (operation: Operation) => `${operation.method} ${operation.template}`;
  const schemaAt = (pointer: string) => contractSchema(`${file}${pointer}`);

  async function requestIssues(operation: Operation, request: Request, url: URL): Promise<string[]> {
    const issues: string[] = [];
    const values = new Map<string, string>();
    const names = [...operation.template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
    operation.pattern.exec(url.pathname)!.slice(1).forEach((value, index) => values.set(`path:${names[index]}`, decodeURIComponent(value)));
    url.searchParams.forEach((value, key) => values.set(`query:${key}`, value));
    request.headers.forEach((value, key) => values.set(`header:${key.toLowerCase()}`, value));
    for (const key of values.keys()) {
      if (key.startsWith("query:") && !operation.parameters.some((parameter) => `${parameter.in}:${parameter.name}` === key)) {
        issues.push(`undocumented query parameter ${key.slice(6)}`);
      }
    }
    for (const parameter of operation.parameters) {
      if (parameter.in === "cookie") continue;
      const value = values.get(`${parameter.in}:${parameter.in === "header" ? parameter.name.toLowerCase() : parameter.name}`);
      if (value === undefined) {
        if (parameter.required) issues.push(`missing ${parameter.in} parameter ${parameter.name}`);
        continue;
      }
      const validate = schemaAt(`${parameter.pointer}/schema`);
      if (!validate(value)) issues.push(`${parameter.in} parameter ${parameter.name}: ${describeErrors(validate.errors)}`);
    }

    const text = await request.text();
    if (!operation.requestBody) {
      if (text !== "") issues.push("a body the operation does not take");
      return issues;
    }
    if (text === "") {
      if (operation.requestBody.required) issues.push("no body");
      return issues;
    }
    const mediaType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!(mediaType in operation.requestBody.content)) return [...issues, `body of undocumented type '${mediaType}'`];
    if (mediaType !== "application/json") return issues;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return [...issues, "a body that is not JSON"];
    }
    const validate = schemaAt(`${operation.pointer}/requestBody/content/${segment(mediaType)}/schema`);
    if (!validate(body)) issues.push(`body: ${describeErrors(validate.errors)}`);
    return issues;
  }

  const responseKey = (operation: Operation, status: number) => (String(status) in operation.responses ? String(status) : "default");
  const mediaTypeOf = (response: Response) => (response.headers.get("content-type") ?? "").split(";")[0]!.trim();

  /*
   * An event stream may stay open, so it is not read up front: its events are checked
   * as they pass to the caller, each against the documented schema of one event. A bad
   * event is recorded as a violation, since the exchange has been answered already.
   */
  function watchEvents(operation: Operation, status: number, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const validate = schemaAt(`${operation.pointer}/responses/${responseKey(operation, status)}/content/${segment("text/event-stream")}/schema`);
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const watched = new ReadableStream<Uint8Array>({ start: (controller) => void (feed = controller) });
    const checked = (async () => {
      for await (const { data, ...fields } of readServerSentEvents(watched)) {
        let event: unknown;
        try {
          event = { ...fields, data: JSON.parse(data) as unknown };
        } catch {
          event = { ...fields, data };
        }
        if (!validate(event)) violations.push(`${label(operation)} answered ${status} with an event ${describeErrors(validate.errors)}: ${JSON.stringify(event)}`);
      }
    })();
    return body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          feed.enqueue(chunk);
        },
        async flush() {
          feed.close();
          await checked;
        },
      }),
    );
  }

  async function responseIssues(operation: Operation, status: number, response: Response): Promise<string[]> {
    const key = responseKey(operation, status);
    const content = operation.responses[key]!.content;
    const text = await response.text();
    if (!content) return text === "" ? [] : ["a body, but the contract documents no content"];
    const mediaType = mediaTypeOf(response);
    if (!(mediaType in content)) return [`a body of undocumented type '${mediaType}'`];
    if (mediaType !== "application/json") return [];
    const validate = schemaAt(`${operation.pointer}/responses/${key}/content/${segment(mediaType)}/schema`);
    return validate(JSON.parse(text)) ? [] : [`body: ${describeErrors(validate.errors)}`];
  }

  async function check(handler: Handler, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const operation = operations.find((candidate) => candidate.method === request.method.toUpperCase() && candidate.pattern.test(url.pathname));
    if (!operation) throw new ContractViolation(`${request.method.toUpperCase()} ${url.pathname} is not an operation of ${file}`);
    const refused = await requestIssues(operation, request.clone(), url);
    const response = await handler(request);
    const status = response.status;
    if (!(String(status) in operation.responses) && !("default" in operation.responses)) {
      throw new ContractViolation(`${label(operation)} answered ${status}, which ${file} does not document`);
    }
    if (refused.length > 0 && !(status >= 400 && status < 500)) {
      throw new ContractViolation(`${label(operation)} answered ${status} to a request ${file} forbids: ${refused.join("; ")}`);
    }
    const content = operation.responses[responseKey(operation, status)]!.content;
    if (mediaTypeOf(response) === "text/event-stream" && response.body && content?.["text/event-stream"]) {
      exercised.add(`${label(operation)} ${status}`);
      const { headers, statusText } = response;
      return new Response(watchEvents(operation, status, response.body), { status, statusText, headers });
    }
    const issues = await responseIssues(operation, status, response.clone());
    if (issues.length > 0) throw new ContractViolation(`${label(operation)} answered ${status} with ${issues.join("; ")}`);
    exercised.add(`${label(operation)} ${status}`);
    return response;
  }

  return {
    guard: (handler) => async (request) => {
      try {
        return await check(handler, request);
      } catch (error) {
        if (error instanceof ContractViolation) violations.push(error.message);
        throw error;
      }
    },
    violations: () => [...violations],
    unexercised: () =>
      operations
        .flatMap((operation) => Object.keys(operation.responses).map((status) => `${label(operation)} ${status}`))
        .filter((response) => !exercised.has(response)),
  };
}
