import { createHash, timingSafeEqual } from "node:crypto";
import { DEFAULT_CHAT_IDLE_MINUTES, enabledAssistant, isTraceparent } from "@tendworks/platform";
import type { ControlPlane } from "@tendworks/shared";
import { Hono, type MiddlewareHandler } from "hono";
import { ChatConflictError, ChatRefusedError, type AgentRuntimePort } from "./agent-runtime.js";
import type { ApprovalsPort, ApprovalStatus, AskApproval } from "./approvals.js";
import type { Configuration } from "./configuration.js";
import type { NotificationsPort } from "./notifications.js";
import { RunRejectedError, type RunsPort } from "./runs.js";
import { checkPlatform, type HealthProbe, type RuntimeBundle } from "./status.js";
import { createInMemoryTriggers, TriggerFireRefusedError, type TriggersPort } from "./triggers.js";
import { serveWebUi, WEB_UI_HEADERS, WEB_UI_PATH, type WebUiOptions } from "./web-ui.js";

type StatusResponse = ControlPlane.paths["/status"]["get"]["responses"];
type Schemas = ControlPlane.components["schemas"];

export interface ControlPlaneApiOptions {
  /** Components the control plane owns, e.g. its store. */
  probes: HealthProbe[];
  /** Other runtime bundles whose components are part of the platform status. */
  bundles?: RuntimeBundle[];
  /** How long a single probe or bundle may take before it counts as unhealthy. */
  probeTimeoutMs?: number;
  /** The validated configuration folder. */
  configuration: Configuration;
  /** Orchestration, which owns runs. */
  runs: RunsPort;
  /** The agent runtime, which owns transcripts of agent sessions; their endpoints answer 503 without it. */
  agentRuntime?: AgentRuntimePort;
  /** The trigger gateway, which owns the schedule; without it no triggers are listed or fired. */
  triggers?: TriggersPort;
  /** Human interaction, which owns notifications; `GET /notifications` answers 503 without it. */
  notifications?: NotificationsPort;
  /** Human interaction's approval requests; their endpoints answer 503 without it. */
  approvals?: ApprovalsPort;
  /**
   * The platform's API token (`apiToken` security scheme): every operation accepts it as
   * a bearer token, and operations that change state need it. Interim until OIDC.
   */
  apiToken: string;
  /**
   * The read-only token (`readToken` security scheme): accepted for reading, refused with
   * 403 by operations that change state. Without it, reading needs the API token.
   */
  readToken?: string;
  /** The built web UI, served under /ui/ without a token (ADR 0018); /ui/ answers 404 without it. */
  webUi?: WebUiOptions;
}

const MINIMUM_TOKEN_LENGTH = 16;

/** Runs the platform still works on, counted in the status overview. */
const ACTIVE_RUN: ReadonlySet<Schemas["run"]["status"]> = new Set(["pending", "running"]);

/**
 * Why the server must not start with these tokens (empty when it may): both must be set
 * (ADR 0014, ADR 0016), each long enough to resist guessing, and the read-only token must
 * not be the API token. Each problem names the variable to set.
 */
export function apiTokenProblems({ apiToken, readToken }: { apiToken?: string; readToken?: string }): string[] {
  const unset = (name: string) => `${name} is not set; set it in deploy/.env; scripts/setup-env.sh creates one with random tokens`;
  const tooShort = (name: string) => `${name} must be at least ${MINIMUM_TOKEN_LENGTH} characters; generate one with \`openssl rand -hex 32\``;
  const problems: string[] = [];
  if (!apiToken) problems.push(unset("TEND_API_TOKEN"));
  else if (apiToken.length < MINIMUM_TOKEN_LENGTH) problems.push(tooShort("TEND_API_TOKEN"));
  if (!readToken) problems.push(unset("TEND_API_READ_TOKEN"));
  else if (readToken.length < MINIMUM_TOKEN_LENGTH) problems.push(tooShort("TEND_API_READ_TOKEN"));
  else if (readToken === apiToken) problems.push("TEND_API_READ_TOKEN must differ from TEND_API_TOKEN, or it could change state");
  return problems;
}

/** The public control plane API as a fetch handler; see contracts/openapi/control-plane.yaml. */
export function createControlPlaneApi({
  probes,
  bundles = [],
  probeTimeoutMs,
  configuration,
  runs,
  agentRuntime,
  triggers = createInMemoryTriggers(),
  notifications,
  approvals,
  apiToken,
  readToken,
  webUi,
}: ControlPlaneApiOptions): { fetch(request: Request): Promise<Response> } {
  if (!apiToken) throw new Error("the control plane API needs an API token");
  const app = new Hono();
  const problem = (status: 400 | 401 | 403 | 404 | 409 | 502 | 503, title: string, detail?: string, headers?: Record<string, string>): Response =>
    Response.json({ title, status, ...(detail === undefined ? {} : { detail }) } satisfies Schemas["Problem"], { status, ...(headers ? { headers } : {}) });

  // Compared as digests, so neither the length nor the content leaks through timing.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(`Bearer ${apiToken}`);
  const expectedRead = readToken ? digest(`Bearer ${readToken}`) : undefined;
  const presented = (authorization: string): "admin" | "read" | undefined => {
    const given = digest(authorization);
    // Both comparisons always run, so timing does not tell which token was close.
    const admin = timingSafeEqual(given, expected);
    const read = expectedRead !== undefined && timingSafeEqual(given, expectedRead);
    return admin ? "admin" : read ? "read" : undefined;
  };
  const challenge = { "www-authenticate": "Bearer" };

  // The web UI is static and public; its pages sign in and call the API like any client.
  const isWebUi = (path: string) => path === "/" || path === "/ui" || path.startsWith(WEB_UI_PATH);

  // Reading (GET, and HEAD, which GET routes answer too) needs either token; only
  // GET /status stays open as the liveness check.
  app.use(async (c, next) => {
    if ((c.req.method !== "GET" && c.req.method !== "HEAD") || c.req.path === "/status" || isWebUi(c.req.path)) return next();
    if (!presented(c.req.header("authorization") ?? "")) {
      return problem(401, "Unauthorized", "reading needs the platform's API token or its read-only token as a bearer token", challenge);
    }
    await next();
  });

  const authenticated: MiddlewareHandler = async (c, next) => {
    const token = presented(c.req.header("authorization") ?? "");
    if (token === "read") return problem(403, "Forbidden", "the read-only token cannot change state; this operation needs the platform's API token");
    if (token !== "admin") {
      return problem(401, "Unauthorized", "this operation needs the platform's API token as a bearer token", challenge);
    }
    await next();
  };

  app.get("/status", async (c) => {
    const [checked, pendingApprovals, activeRuns] = await Promise.all([
      checkPlatform(probes, bundles, probeTimeoutMs),
      // Part of the overview, not of health: unreadable approvals or runs leave the number out.
      approvals?.list({ status: "pending" }).then(
        (pending) => pending.length,
        () => undefined,
      ),
      runs.list().then(
        (all) => all.filter((run) => ACTIVE_RUN.has(run.status)).length,
        () => undefined,
      ),
    ]);
    const report = { ...checked, ...(pendingApprovals === undefined ? {} : { pendingApprovals }), ...(activeRuns === undefined ? {} : { activeRuns }) };
    if (report.status === "healthy") {
      return c.json(report satisfies StatusResponse[200]["content"]["application/json"], 200);
    }
    return c.json(report satisfies StatusResponse[503]["content"]["application/json"], 503);
  });

  // The platform's root address and /ui lead to the web UI.
  app.get("/", (c) => c.redirect(WEB_UI_PATH, 302));
  app.get("/ui", (c) => c.redirect(WEB_UI_PATH, 302));
  app.get(`${WEB_UI_PATH}*`, async (c) => {
    const served = webUi && (await serveWebUi(webUi, c.req.path, c.req.method));
    if (served) return served;
    if (!webUi) return problem(404, "Web UI not available", "this server was started without a web UI build", { ...WEB_UI_HEADERS });
    return problem(404, "Not found", undefined, { ...WEB_UI_HEADERS });
  });

  // The global middleware above already refused a request without either token.
  app.get("/access", (c) => c.json({ scope: presented(c.req.header("authorization") ?? "") === "admin" ? "full" : "read" } satisfies Schemas["Access"], 200));

  app.post("/runs", authenticated, async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as Partial<Schemas["StartRunRequest"]> | undefined;
    if (typeof body?.workflow !== "string") return problem(400, "Invalid request", "`workflow` must be the name of a configured workflow");
    if (body.input !== undefined && (body.input === null || typeof body.input !== "object" || Array.isArray(body.input))) {
      return problem(400, "Invalid request", "`input` must be an object");
    }
    const traceparent = c.req.header("traceparent");
    if (traceparent !== undefined && !isTraceparent(traceparent)) return problem(400, "Invalid request", "`traceparent` must be a W3C traceparent (version 00)");
    const definition = configuration.workflow(body.workflow);
    if (!definition) {
      return problem(400, "Unknown workflow", `no workflow '${body.workflow}' is configured (configured: ${configuration.workflowNames.join(", ") || "none"})`);
    }
    const run = await runs.start(
      { workflow: definition as unknown as Record<string, unknown>, input: body.input ?? {}, startedBy: body.startedBy ?? { kind: "manual" } },
      traceparent ? { traceparent } : {},
    );
    return c.json(run satisfies Schemas["run"], 201, { location: `/runs/${run.id}` });
  });

  app.post("/runs/:runId/retry", authenticated, async (c) => {
    const finished = await runs.get(c.req.param("runId"));
    if (!finished) return problem(404, "Run not found");
    // A completed run may have delivered the wrong result; a run at work still works on its item.
    if (finished.status !== "failed" && finished.status !== "completed") {
      return problem(409, "Run not retryable", `run ${finished.id} is ${finished.status}; only a finished run can be retried`);
    }
    // The workflow as configured now, so a fixed workflow takes effect.
    const definition = configuration.workflow(finished.workflow);
    if (!definition) {
      return problem(409, "Run not retryable", `its workflow '${finished.workflow}' is no longer configured (configured: ${configuration.workflowNames.join(", ") || "none"})`);
    }
    const run = await runs
      .start({
        workflow: definition as unknown as Record<string, unknown>,
        input: finished.input as Record<string, unknown>,
        startedBy: { ...(finished.startedBy ?? { kind: "manual" }), retryOf: finished.id },
      })
      .catch((error: unknown) => {
        if (error instanceof RunRejectedError) return problem(409, "Run not retryable", error.detail ?? error.title);
        throw error;
      });
    if (run instanceof Response) return run;
    return c.json(run satisfies Schemas["run"], 201, { location: `/runs/${run.id}` });
  });

  app.get("/runs", async (c) => c.json({ items: await runs.list() } satisfies Schemas["RunList"], 200));

  app.get("/runs/:runId", async (c) => {
    const run = await runs.get(c.req.param("runId"));
    return run ? c.json(run satisfies Schemas["run"], 200) : problem(404, "Run not found");
  });

  app.get("/runs/:runId/tasks/:taskId/transcript", async (c) => {
    const runId = c.req.param("runId");
    const taskId = c.req.param("taskId");
    const run = await runs.get(runId);
    if (!run) return problem(404, "Run not found");
    if (!run.steps.some((step) => step.taskId === taskId)) return problem(404, "Task not found", `no step of run ${runId} handed task ${taskId} to an agent`);
    if (!agentRuntime) return problem(503, "Agent runtime unavailable", "no agent runtime is configured");
    let items;
    try {
      items = await agentRuntime.transcript(taskId);
    } catch (error) {
      return problem(503, "Agent runtime unavailable", error instanceof Error ? error.message : String(error));
    }
    if (!items) return problem(404, "Transcript not found", `task ${taskId} has no transcript`);
    return c.json({ items } satisfies Schemas["TranscriptEntryList"], 200);
  });

  app.get("/runs/:runId/tasks/:taskId/transcript/stream", async (c) => {
    const runId = c.req.param("runId");
    const taskId = c.req.param("taskId");
    const lastEventId = c.req.header("last-event-id");
    if (lastEventId !== undefined && !/^(0|[1-9][0-9]*)$/.test(lastEventId)) {
      return problem(400, "Invalid Last-Event-ID", "Last-Event-ID must be the position of a transcript entry, e.g. 41");
    }
    const run = await runs.get(runId);
    if (!run) return problem(404, "Run not found");
    if (!run.steps.some((step) => step.taskId === taskId)) return problem(404, "Task not found", `no step of run ${runId} handed task ${taskId} to an agent`);
    if (!agentRuntime) return problem(503, "Agent runtime unavailable", "no agent runtime is configured");
    let stream;
    try {
      stream = await agentRuntime.streamTranscript(taskId, lastEventId === undefined ? {} : { after: Number(lastEventId) });
    } catch (error) {
      return problem(503, "Agent runtime unavailable", error instanceof Error ? error.message : String(error));
    }
    if (!stream) return problem(404, "Transcript not found", `task ${taskId} has no transcript`);
    // Passed through as it comes (ADR 0017); the agent runtime ends it when the task ends.
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
  });

  // Chats (ADR 0015) live in the agent runtime; the control plane passes them through.
  const POSITION = /^(0|[1-9][0-9]*)$/;
  const runtimeUnavailable = (detail: string) => problem(503, "Agent runtime unavailable", detail);
  /** Calls the agent runtime, mapping its refusals to 400/409 and anything else to 503. */
  const throughRuntime = async (work: (runtime: AgentRuntimePort) => Promise<Response>): Promise<Response> => {
    if (!agentRuntime) return runtimeUnavailable("no agent runtime is configured");
    try {
      return await work(agentRuntime);
    } catch (error) {
      if (error instanceof ChatRefusedError) return problem(400, error.title, error.detail);
      if (error instanceof ChatConflictError) return problem(409, error.title, error.detail);
      return runtimeUnavailable(error instanceof Error ? error.message : String(error));
    }
  };
  const noChat = (chatId: string) => problem(404, "Chat not found", `no chat '${chatId}' exists`);
  const textOf = (body: Record<string, unknown> | undefined) => (typeof body?.text === "string" && body.text !== "" ? body.text : undefined);

  app.post("/chats", authenticated, async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const text = textOf(body);
    const { agent, workspace, ...rest } = body ?? {};
    const valid =
      text !== undefined &&
      Object.keys(rest).every((key) => key === "text") &&
      ((typeof agent === "string" && workspace === undefined) || (typeof workspace === "string" && agent === undefined));
    if (!valid) {
      return problem(
        400,
        "Invalid request",
        "the body must be { agent, text } with the name of an agent profile that allows chats, or { workspace, text } with the name of a workspace whose assistant is enabled, and the first message",
      );
    }
    return throughRuntime(async (runtime) => {
      // The agent runtime decides whether the profile or the workspace's assistant allows the chat.
      const chat = await runtime.startChat(typeof agent === "string" ? { agent, text } : { workspace: workspace as string, text });
      return c.json(chat satisfies Schemas["chat"], 201, { location: `/chats/${chat.id}` });
    });
  });

  app.get("/chats", async (c) => throughRuntime(async (runtime) => c.json({ items: await runtime.listChats() } satisfies Schemas["chatList"], 200)));

  app.get("/chats/:chatId", async (c) => {
    const chatId = c.req.param("chatId");
    return throughRuntime(async (runtime) => {
      const chat = await runtime.getChat(chatId);
      return chat ? c.json(chat satisfies Schemas["chat"], 200) : noChat(chatId);
    });
  });

  app.post("/chats/:chatId/messages", authenticated, async (c) => {
    const chatId = c.req.param("chatId");
    const text = textOf((await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined);
    if (text === undefined) return problem(400, "Invalid request", "the body must be { text } with the next message");
    return throughRuntime(async (runtime) => {
      const chat = await runtime.sendChatMessage(chatId, text);
      return chat ? c.json(chat satisfies Schemas["chat"], 200) : noChat(chatId);
    });
  });

  app.post("/chats/:chatId/cancel", authenticated, async (c) => {
    const chatId = c.req.param("chatId");
    return throughRuntime(async (runtime) => {
      const chat = await runtime.cancelChatTurn(chatId);
      return chat ? c.json(chat satisfies Schemas["chat"], 200) : noChat(chatId);
    });
  });

  app.post("/chats/:chatId/end", authenticated, async (c) => {
    const chatId = c.req.param("chatId");
    return throughRuntime(async (runtime) => {
      const chat = await runtime.endChat(chatId);
      return chat ? c.json(chat satisfies Schemas["chat"], 200) : noChat(chatId);
    });
  });

  app.get("/chats/:chatId/transcript", async (c) => {
    const chatId = c.req.param("chatId");
    return throughRuntime(async (runtime) => {
      // Only a chat's transcript: a task id of a run's step is no chat.
      if (!(await runtime.getChat(chatId))) return noChat(chatId);
      const items = await runtime.transcript(chatId);
      return items ? c.json({ items } satisfies Schemas["TranscriptEntryList"], 200) : noChat(chatId);
    });
  });

  app.get("/chats/:chatId/transcript/stream", async (c) => {
    const chatId = c.req.param("chatId");
    const lastEventId = c.req.header("last-event-id");
    if (lastEventId !== undefined && !POSITION.test(lastEventId)) {
      return problem(400, "Invalid Last-Event-ID", "Last-Event-ID must be the position of a transcript entry, e.g. 41");
    }
    return throughRuntime(async (runtime) => {
      if (!(await runtime.getChat(chatId))) return noChat(chatId);
      const stream = await runtime.streamTranscript(chatId, lastEventId === undefined ? {} : { after: Number(lastEventId) });
      if (!stream) return noChat(chatId);
      // Passed through as it comes (ADR 0017); the agent runtime ends it when the chat ends.
      return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
    });
  });

  app.get("/agents", async (c) => {
    // Who works right now lives in the agent runtime; the profiles come from the configuration,
    // so they are listed also when the agent runtime cannot be reached, without sessions then.
    const sessions = await agentRuntime?.listSessions().catch(() => undefined);
    const items = configuration.agentProfiles
      .map(({ metadata, spec }): Schemas["Agent"] => {
        const secrets = Object.values(spec.env ?? {}).map(({ secretRef }) => secretRef.name);
        return {
          name: metadata.name,
          harness: spec.harness,
          ...(spec.sandbox === undefined ? {} : { sandbox: spec.sandbox }),
          ...(spec.skills?.length ? { skills: [...spec.skills] } : {}),
          ...(secrets.length > 0 ? { secrets } : {}),
          // With the schema's default, so clients see what applies.
          ...(spec.chat === undefined ? {} : { chat: { idleMinutes: spec.chat.idleMinutes ?? DEFAULT_CHAT_IDLE_MINUTES } }),
          ...(spec.mcp?.length ? { mcp: [...spec.mcp] } : {}),
          ...(sessions ? { sessions: sessions.filter((session) => session.agent === metadata.name) } : {}),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ items } satisfies Schemas["AgentList"], 200);
  });

  // Whom a client can chat with besides profiles: the workspaces with an enabled assistant (ADR 0022).
  app.get("/workspaces", (c) => {
    const items = configuration.workspaces.map(({ metadata: { name }, spec }): Schemas["WorkspaceSummary"] => {
      const assistant = enabledAssistant(spec.assistant);
      return { name, kind: spec.directory ? "directory" : "git", ...(assistant ? { assistant } : {}) };
    });
    return c.json({ items } satisfies Schemas["WorkspaceList"], 200);
  });

  // Read-only view of the configured subscriptions (ADR 0026); they are configured in the configuration repository.
  app.get("/subscriptions", (c) => {
    const items = configuration.subscriptions.map(({ metadata, spec }): Schemas["SubscriptionSummary"] => ({
      name: metadata.name,
      scope: spec.scope,
      events: [...spec.events],
      channels: [...spec.channels],
      ...(spec.priority === undefined ? {} : { priority: spec.priority }),
    }));
    return c.json({ items } satisfies Schemas["SubscriptionList"], 200);
  });

  app.get("/triggers", async (c) => {
    let items;
    try {
      items = await triggers.list();
    } catch (error) {
      return problem(503, "Trigger gateway unavailable", error instanceof Error ? error.message : String(error));
    }
    return c.json({ items } satisfies Schemas["triggerList"], 200);
  });

  app.post("/triggers/:name/fire", authenticated, async (c) => {
    // The body is optional; without one the firing covers all of the binding's workspaces.
    const text = await c.req.text();
    let body: unknown = {};
    try {
      if (text.trim() !== "") body = JSON.parse(text);
    } catch {
      return problem(400, "Invalid request", "the body must be a JSON object");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return problem(400, "Invalid request", "the body must be a JSON object");
    const { workspace } = body as { workspace?: unknown };
    if (workspace !== undefined && typeof workspace !== "string") return problem(400, "Invalid request", "`workspace` must be the name of one of the binding's workspaces");
    let result;
    try {
      result = await triggers.fire(c.req.param("name"), workspace === undefined ? {} : { workspace });
    } catch (error) {
      if (error instanceof TriggerFireRefusedError) return problem(error.status, error.title, error.detail);
      return problem(503, "Trigger gateway unavailable", error instanceof Error ? error.message : String(error));
    }
    return c.json(result satisfies Schemas["fireResult"], 201);
  });

  app.get("/notifications", async (c) => {
    if (!notifications) return problem(503, "Notifications unavailable", "no notification store is configured");
    try {
      return c.json({ items: await notifications.list() } satisfies Schemas["NotificationList"], 200);
    } catch (error) {
      return problem(503, "Notifications unavailable", error instanceof Error ? error.message : String(error));
    }
  });

  const STATUSES: ApprovalStatus[] = ["pending", "decided"];

  app.get("/approval-requests", async (c) => {
    const status = c.req.query("status");
    if (status !== undefined && !STATUSES.includes(status as ApprovalStatus)) {
      return problem(400, "Invalid request", `\`status\` must be one of ${STATUSES.join(", ")}`);
    }
    if (!approvals) return problem(503, "Approval requests unavailable", "no approval store is configured");
    try {
      const items = await approvals.list(status === undefined ? {} : { status: status as ApprovalStatus });
      return c.json({ items } satisfies Schemas["ApprovalRequestList"], 200);
    } catch (error) {
      return problem(503, "Approval requests unavailable", error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/approval-requests/:approvalRequestId", async (c) => {
    if (!approvals) return problem(503, "Approval requests unavailable", "no approval store is configured");
    const id = c.req.param("approvalRequestId");
    let request;
    try {
      request = await approvals.get(id);
    } catch (error) {
      return problem(503, "Approval requests unavailable", error instanceof Error ? error.message : String(error));
    }
    if (!request) return problem(404, "Approval request not found", `no approval request '${id}' exists`);
    return c.json(request satisfies Schemas["approvalRequest"], 200);
  });

  // A workflow's human step asks; human interaction decides by the run's own record.
  app.post("/approval-requests", authenticated, async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const invalid = askProblem(body);
    if (invalid) return problem(400, "Invalid request", invalid);
    if (!approvals) return problem(503, "Approval requests unavailable", "no approval store is configured");
    let outcome;
    try {
      outcome = await approvals.ask(body as AskApproval);
    } catch (error) {
      return problem(503, "Approval requests unavailable", error instanceof Error ? error.message : String(error));
    }
    if ("refused" in outcome) {
      const { reason, detail } = outcome.refused;
      if (reason === "unknown-run") return problem(404, "Run not found", detail);
      if (reason === "not-running") return problem(409, "Run is not running", detail);
      return problem(400, "Invalid request", detail);
    }
    return c.json(outcome satisfies Schemas["ApprovalOutcome"], 200);
  });

  app.post("/approval-requests/:approvalRequestId/decision", authenticated, async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as Partial<Schemas["ApprovalDecisionRequest"]> | undefined;
    if (typeof body?.answer !== "string" || body.answer === "" || Object.keys(body).length !== 1) {
      return problem(400, "Invalid request", "the body must be { answer } with the label of one of the request's answers");
    }
    if (!approvals) return problem(503, "Approval requests unavailable", "no approval store is configured");
    const id = c.req.param("approvalRequestId");
    let outcome;
    try {
      outcome = await approvals.decide(id, body.answer);
    } catch (error) {
      return problem(503, "Approval requests unavailable", error instanceof Error ? error.message : String(error));
    }
    if (!outcome) return problem(404, "Approval request not found", `no approval request '${id}' exists`);
    if ("unknownAnswer" in outcome) {
      const offered = outcome.unknownAnswer.answers.map(({ label }) => `'${label}'`).join(", ");
      return problem(400, "Unknown answer", `approval request ${id} offers no answer '${body.answer}' (answers: ${offered})`);
    }
    if ("conflict" in outcome) {
      return problem(409, "Approval request already decided", `approval request ${id} was already decided with '${outcome.conflict.answer ?? ""}'`);
    }
    return c.json(outcome.decided satisfies Schemas["approvalRequest"], 200);
  });

  app.onError((error) => {
    if (error instanceof RunRejectedError) return problem(400, error.title, error.detail);
    return problem(503, "Orchestration unavailable", error.message);
  });

  return { fetch: async (request) => app.fetch(request) };
}

const NAME = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

/** Why `body` is not a question a human step can ask (`AskApprovalRequest`); `undefined` when it is. */
function askProblem(body: unknown): string | undefined {
  const text = (value: unknown) => typeof value === "string" && value !== "";
  const only = (value: object, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
  if (!isRecord(body) || !only(body, ["run", "step", "action", "question", "links", "answers"])) {
    return "the body must be { run, step, action, question, links?, answers }";
  }
  if (!text(body.run) || !text(body.step)) return "`run` and `step` must name the running run and its human step";
  if (typeof body.action !== "string" || !NAME.test(body.action)) return "`action` must be a name of letters, digits and dashes";
  if (!text(body.question)) return "`question` must not be empty";
  const links = body.links ?? [];
  const link = (value: unknown) =>
    isRecord(value) && only(value, ["title", "url"]) && text(value.title) && typeof value.url === "string" && /^https?:\/\/./.test(value.url);
  if (!Array.isArray(links) || !links.every(link)) return "`links` must be a list of { title, url } with http(s) URLs";
  const answer = (value: unknown) => isRecord(value) && only(value, ["label", "outcome"]) && text(value.label) && (value.outcome === "continue" || value.outcome === "stop");
  if (!Array.isArray(body.answers) || body.answers.length === 0 || !body.answers.every(answer)) {
    return "`answers` must be a non-empty list of { label, outcome } with outcome continue or stop";
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
