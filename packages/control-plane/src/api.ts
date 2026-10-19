import { createHash, timingSafeEqual } from "node:crypto";
import { isTraceparent } from "@tendworks/platform";
import type { ControlPlane } from "@tendworks/shared";
import { Hono, type MiddlewareHandler } from "hono";
import { ChatConflictError, ChatRefusedError, type AgentRuntimePort } from "./agent-runtime.js";
import type { ApprovalsPort, ApprovalStatus } from "./approvals.js";
import type { Configuration } from "./configuration.js";
import { REFUSAL_STATUS, type MergesPort } from "./merges.js";
import type { NotificationsPort } from "./notifications.js";
import { RunRejectedError, type RunsPort } from "./runs.js";
import { checkPlatform, type HealthProbe, type RuntimeBundle } from "./status.js";
import { createInMemoryTriggers, type TriggersPort } from "./triggers.js";

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
  /** The trigger gateway, which owns the schedule; without it no triggers are listed. */
  triggers?: TriggersPort;
  /** Human interaction, which owns notifications; `GET /notifications` answers 503 without it. */
  notifications?: NotificationsPort;
  /** Human interaction's merge gate; `POST /pull-requests/merge` answers 503 without it. */
  merges?: MergesPort;
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
}

const MINIMUM_TOKEN_LENGTH = 16;

/**
 * Why the server must not start with these tokens (empty when it may): each must be long
 * enough to resist guessing, and the read-only token must not be the API token. Agent
 * profiles that list the platform MCP server need the read-only token (ADR 0016), so it
 * must be set when any of `agentProfiles` does.
 */
export function apiTokenProblems({
  apiToken,
  readToken,
  agentProfiles = [],
}: Pick<ControlPlaneApiOptions, "apiToken" | "readToken"> & { agentProfiles?: Configuration["agentProfiles"] }): string[] {
  const tooShort = (name: string) => `${name} must be at least ${MINIMUM_TOKEN_LENGTH} characters; generate one with \`openssl rand -hex 32\``;
  const problems: string[] = [];
  if (apiToken.length < MINIMUM_TOKEN_LENGTH) problems.push(tooShort("TEND_API_TOKEN"));
  const readers = agentProfiles.filter((profile) => profile.spec.mcp?.includes("tendworks")).map((profile) => profile.metadata.name);
  if (readToken === undefined && readers.length > 0) {
    const profiles = `agent profile${readers.length > 1 ? "s" : ""} ${readers.join(", ")} list${readers.length > 1 ? "" : "s"}`;
    problems.push(`TEND_API_READ_TOKEN must be set: ${profiles} the platform MCP server (mcp: [tendworks]), which reads with it`);
  }
  if (readToken !== undefined) {
    if (readToken.length < MINIMUM_TOKEN_LENGTH) problems.push(tooShort("TEND_API_READ_TOKEN"));
    else if (readToken === apiToken) problems.push("TEND_API_READ_TOKEN must differ from TEND_API_TOKEN, or it could change state");
  }
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
  merges,
  approvals,
  apiToken,
  readToken,
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

  // Reading (GET, and HEAD, which GET routes answer too) needs either token; only
  // GET /status stays open as the liveness check.
  app.use(async (c, next) => {
    if ((c.req.method !== "GET" && c.req.method !== "HEAD") || c.req.path === "/status") return next();
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
    const [checked, pendingApprovals] = await Promise.all([
      checkPlatform(probes, bundles, probeTimeoutMs),
      // Part of the overview, not of health: unreadable approvals leave the number out.
      approvals?.list({ status: "pending" }).then(
        (pending) => pending.length,
        () => undefined,
      ),
    ]);
    const report = { ...checked, ...(pendingApprovals === undefined ? {} : { pendingApprovals }) };
    if (report.status === "healthy") {
      return c.json(report satisfies StatusResponse[200]["content"]["application/json"], 200);
    }
    return c.json(report satisfies StatusResponse[503]["content"]["application/json"], 503);
  });

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
    const repository = body?.repository;
    if (typeof body?.agent !== "string" || text === undefined || (repository !== undefined && typeof repository !== "string")) {
      return problem(
        400,
        "Invalid request",
        "the body must be { agent, text, repository? } with the name of an agent profile that allows chats, the first message and a clone URL",
      );
    }
    const agent = body.agent;
    return throughRuntime(async (runtime) => {
      // The agent runtime checks the repository: it owns the workspace rules.
      const chat = await runtime.startChat({ agent, text, ...(repository === undefined ? {} : { repository }) });
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

  app.get("/agents", async (c) =>
    throughRuntime(async (runtime) => {
      // Who works right now lives in the agent runtime; the profiles come from the configuration.
      const sessions = await runtime.listSessions();
      const items = configuration.agentProfiles
        .map(({ metadata, spec }): Schemas["Agent"] => {
          const secrets = Object.values(spec.env ?? {}).map(({ secretRef }) => secretRef.name);
          return {
            name: metadata.name,
            harness: spec.harness,
            ...(spec.sandbox === undefined ? {} : { sandbox: spec.sandbox }),
            ...(spec.skills?.length ? { skills: [...spec.skills] } : {}),
            ...(secrets.length > 0 ? { secrets } : {}),
            sessions: sessions.filter((session) => session.agent === metadata.name),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return c.json({ items } satisfies Schemas["AgentList"], 200);
    }),
  );

  app.get("/triggers", async (c) => {
    let items;
    try {
      items = await triggers.list();
    } catch (error) {
      return problem(503, "Trigger gateway unavailable", error instanceof Error ? error.message : String(error));
    }
    return c.json({ items } satisfies Schemas["triggerList"], 200);
  });

  app.get("/notifications", async (c) => {
    if (!notifications) return problem(503, "Notifications unavailable", "no notification store is configured");
    try {
      return c.json({ items: await notifications.list() } satisfies Schemas["NotificationList"], 200);
    } catch (error) {
      return problem(503, "Notifications unavailable", error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/pull-requests/merge", authenticated, async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    // Only these two fields: what the gate decides by comes from the platform's records.
    const valid =
      body !== undefined &&
      typeof body.run === "string" &&
      (typeof body.pullRequest === "string" || body.pullRequest === null) &&
      Object.keys(body).every((key) => key === "run" || key === "pullRequest");
    if (!valid) {
      return problem(
        400,
        "Invalid request",
        "the body must be { run, pullRequest } with the id of a running run and the URL of its pull request (or null); the policy comes from the platform's configuration",
      );
    }
    if (!merges) return problem(503, "Merging unavailable", "no merge gate is configured");
    const outcome = await merges.merge({ run: body.run as string, pullRequest: body.pullRequest as string | null });
    if ("merged" in outcome) return c.json(outcome.merged satisfies Schemas["PullRequestMerge"], 200);
    if ("pending" in outcome) return c.json(outcome.pending satisfies Schemas["PullRequestMerge"], 202);
    const { reason, title, detail } = outcome.refused;
    return problem(REFUSAL_STATUS[reason], title, detail);
  });

  const STATUSES: ApprovalStatus[] = ["pending", "approved", "rejected"];

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

  app.post("/approval-requests/:approvalRequestId/decision", authenticated, async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as Partial<Schemas["ApprovalDecisionRequest"]> | undefined;
    if (body?.decision !== "approve" && body?.decision !== "reject") {
      return problem(400, "Invalid request", "`decision` must be approve or reject");
    }
    if (!approvals) return problem(503, "Approval requests unavailable", "no approval store is configured");
    const id = c.req.param("approvalRequestId");
    let outcome;
    try {
      outcome = await approvals.decide(id, body.decision);
    } catch (error) {
      return problem(503, "Approval requests unavailable", error instanceof Error ? error.message : String(error));
    }
    if (!outcome) return problem(404, "Approval request not found", `no approval request '${id}' exists`);
    if ("conflict" in outcome) {
      return problem(409, "Approval request already decided", `approval request ${id} was already ${outcome.conflict.status}`);
    }
    return c.json(outcome.decided satisfies Schemas["approvalRequest"], 200);
  });

  app.onError((error) => {
    if (error instanceof RunRejectedError) return problem(400, error.title, error.detail);
    return problem(503, "Orchestration unavailable", error.message);
  });

  return { fetch: async (request) => app.fetch(request) };
}
