import type { ControlPlane } from "@tendworks/shared";
import { Command, CommanderError, Option } from "commander";
import createClient from "openapi-fetch";
import { stringify as stringifyYaml } from "yaml";

type PlatformStatus = ControlPlane.components["schemas"]["PlatformStatus"];
type RunList = ControlPlane.components["schemas"]["RunList"];
type Run = ControlPlane.components["schemas"]["run"];
type WorkflowError = ControlPlane.components["schemas"]["workflowError"];
type Cost = ControlPlane.components["schemas"]["cost"];
type TriggerList = ControlPlane.components["schemas"]["triggerList"];
type Duration = ControlPlane.components["schemas"]["duration"];
type NotificationList = ControlPlane.components["schemas"]["NotificationList"];
type ApprovalRequestList = ControlPlane.components["schemas"]["ApprovalRequestList"];
type AgentList = ControlPlane.components["schemas"]["AgentList"];

/** Stable exit codes, so scripts and CI can rely on them. */
export const ExitCode = { ok: 0, error: 1, unhealthy: 2 } as const;

export interface TendIo {
  /** Transport to the control plane; defaults to the global fetch. */
  fetch?: (request: Request) => Promise<Response>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Runs one tend command line and resolves to its exit code. */
export async function runTend(args: string[], io: TendIo): Promise<number> {
  let exitCode: number = ExitCode.ok;
  const program = new Command("tend")
    .description("command line for the Tendworks agent platform")
    .addOption(
      new Option("--url <url>", "control plane URL").env("TEND_URL").default("http://localhost:8080"),
    )
    .addOption(new Option("--token <token>", "the platform's API token, needed by commands that change state").env("TEND_API_TOKEN"))
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  const controlPlane = (command: Command) => {
    const { url: baseUrl, token } = command.optsWithGlobals<{ url: string; token?: string }>();
    return {
      baseUrl,
      client: createClient<ControlPlane.paths>({
        baseUrl,
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        ...(io.fetch ? { fetch: io.fetch } : {}),
      }),
    };
  };

  program
    .command("status")
    .description("show platform health")
    .addOption(outputOption())
    .action(async (options: { output: OutputFormat }, command: Command) => {
      const { baseUrl, client } = controlPlane(command);
      const { data, error, response } = await client.GET("/status").catch((cause: unknown) => {
        throw new UnreachableError(baseUrl, cause);
      });
      // 200 and 503 both carry a status document; anything else did not come from the control plane.
      const report: PlatformStatus | undefined = response.status === 200 || response.status === 503 ? (data ?? error) : undefined;
      if (!report?.components) throw new Error(`unexpected answer from the control plane (HTTP ${response.status})`);
      io.stdout(render(report, options.output, formatTable));
      exitCode = report.status === "healthy" ? ExitCode.ok : ExitCode.unhealthy;
    });

  const run = program.command("run").description("inspect runs");

  run
    .command("list")
    .description("list runs, newest first")
    .addOption(outputOption())
    .action(async (options: { output: OutputFormat }, command: Command) => {
      const { baseUrl, client } = controlPlane(command);
      const { data, error, response } = await client.GET("/runs").catch((cause: unknown) => {
        throw new UnreachableError(baseUrl, cause);
      });
      if (!data) throw new AnswerError(response, error);
      io.stdout(render(data, options.output, formatRunList));
    });

  run
    .command("get")
    .description("show one run with its steps and errors")
    .argument("<id>", "run id")
    .addOption(outputOption())
    .action(async (runId: string, options: { output: OutputFormat }, command: Command) => {
      const { baseUrl, client } = controlPlane(command);
      const { data, error, response } = await client.GET("/runs/{runId}", { params: { path: { runId } } }).catch((cause: unknown) => {
        throw new UnreachableError(baseUrl, cause);
      });
      if (response.status === 404) throw new Error(`run ${runId} not found`);
      if (!data) throw new AnswerError(response, error);
      io.stdout(render(data, options.output, formatRun));
    });

  program
    .command("agent")
    .description("inspect agent profiles")
    .command("list")
    .description("list the configured agent profiles")
    .addOption(outputOption())
    .action(async (options: { output: OutputFormat }, command: Command) => {
      const { baseUrl, client } = controlPlane(command);
      const { data, error, response } = await client.GET("/agents").catch((cause: unknown) => {
        throw new UnreachableError(baseUrl, cause);
      });
      if (!data) throw new AnswerError(response, error);
      io.stdout(render(data, options.output, formatAgentList));
    });

  program
    .command("trigger")
    .description("inspect triggers")
    .command("list")
    .description("list trigger bindings with their next scheduled execution")
    .addOption(outputOption())
    .action(async (options: { output: OutputFormat }, command: Command) => {
      const { baseUrl, client } = controlPlane(command);
      const { data, error, response } = await client.GET("/triggers").catch((cause: unknown) => {
        throw new UnreachableError(baseUrl, cause);
      });
      if (!data) throw new AnswerError(response, error);
      io.stdout(render(data, options.output, formatTriggerList));
    });

  const notification = program.command("notification").description("inspect notifications");

  notification
    .command("list")
    .description("list notifications, newest first, with their delivery status")
    .addOption(outputOption())
    .action(async (options: { output: OutputFormat }, command: Command) => {
      const { baseUrl, client } = controlPlane(command);
      const { data, error, response } = await client.GET("/notifications").catch((cause: unknown) => {
        throw new UnreachableError(baseUrl, cause);
      });
      if (!data) throw new AnswerError(response, error);
      io.stdout(render(data, options.output, formatNotificationList));
    });

  const approval = program.command("approval").description("answer approval requests");

  approval
    .command("list")
    .description("list approval requests, newest first")
    .option("--pending", "only requests that wait for a decision")
    .addOption(outputOption())
    .action(async (options: { output: OutputFormat; pending?: boolean }, command: Command) => {
      const { baseUrl, client } = controlPlane(command);
      const { data, error, response } = await client
        .GET("/approval-requests", { params: { query: options.pending ? { status: "pending" } : {} } })
        .catch((cause: unknown) => {
          throw new UnreachableError(baseUrl, cause);
        });
      if (!data) throw new AnswerError(response, error);
      io.stdout(render(data, options.output, formatApprovalList));
    });

  for (const [name, decision, done] of [
    ["approve", "approve", "approved"],
    ["reject", "reject", "rejected"],
  ] as const) {
    approval
      .command(name)
      .description(`${name} an approval request; the waiting run goes on`)
      .argument("<id>", "approval request id")
      .action(async (id: string, _options: unknown, command: Command) => {
        const { baseUrl, client } = controlPlane(command);
        const { data, error, response } = await client
          .POST("/approval-requests/{approvalRequestId}/decision", { params: { path: { approvalRequestId: id } }, body: { decision } })
          .catch((cause: unknown) => {
            throw new UnreachableError(baseUrl, cause);
          });
        if (response.status === 404) throw new Error(`approval request ${id} not found`);
        if (!data) throw new AnswerError(response, error);
        io.stdout(`approval request ${data.id} ${done}\n`);
      });
  }

  try {
    await program.parseAsync(args, { from: "user" });
    return exitCode;
  } catch (error) {
    // Commander has already written its own message to stderr.
    if (error instanceof CommanderError) return error.exitCode === 0 ? ExitCode.ok : ExitCode.error;
    io.stderr(`tend: ${error instanceof Error ? error.message : String(error)}\n`);
    return ExitCode.error;
  }
}

class UnreachableError extends Error {
  constructor(baseUrl: string, cause: unknown) {
    super(`cannot reach the control plane at ${baseUrl} (${cause instanceof Error ? cause.message : String(cause)})`);
  }
}

class AnswerError extends Error {
  constructor(response: Response, problem?: { title?: string; detail?: string }) {
    if (response.status === 401) {
      super("the control plane refused the API token (HTTP 401); set TEND_API_TOKEN or pass --token");
      return;
    }
    const reason = problem?.title ? `: ${problem.title}${problem.detail ? ` (${problem.detail})` : ""}` : "";
    super(`unexpected answer from the control plane (HTTP ${response.status})${reason}`);
  }
}

type OutputFormat = "table" | "json" | "yaml";

/** Every read command supports -o, so runtime state can be read as a document. */
function outputOption(): Option {
  return new Option("-o, --output <format>", "output format").choices(["table", "json", "yaml"]).default("table");
}

function render<T>(document: T, format: OutputFormat, table: (document: T) => string): string {
  if (format === "json") return `${JSON.stringify(document, null, 2)}\n`;
  if (format === "yaml") return stringifyYaml(document);
  return table(document);
}

function formatTable(report: PlatformStatus): string {
  const rows = [["COMPONENT", "STATUS", "MESSAGE"], ...report.components.map((c) => [c.name, c.status, c.message ?? ""])];
  const pending = report.pendingApprovals === undefined ? "" : `PENDING APPROVALS  ${report.pendingApprovals}\n`;
  return `PLATFORM  ${report.status}\n${pending}\n${table(rows)}`;
}

function formatRunList(list: RunList): string {
  const rows = [
    ["ID", "WORKFLOW", "STATUS", "STARTED BY", "CREATED", "FINISHED"],
    ...list.items.map((run) => [run.id, run.workflow, run.status, formatOrigin(run.startedBy), run.createdAt, run.finishedAt ?? ""]),
  ];
  return table(rows);
}

/** `manual`, or `trigger <binding>: <owner>/<name>#<n>`; empty for runs recorded without an origin. */
function formatOrigin(origin: Run["startedBy"], { url = false }: { url?: boolean } = {}): string {
  if (!origin) return "";
  if (origin.kind === "manual") return "manual";
  return `trigger ${origin.binding}: ${origin.issue.repository}#${origin.issue.number}${url ? ` (${origin.issue.url})` : ""}`;
}

function formatAgentList(list: AgentList): string {
  const rows = [
    ["NAME", "HARNESS", "SANDBOX", "SKILLS"],
    ...list.items.map((agent) => [agent.name, agent.harness, agent.sandbox ?? "", (agent.skills ?? []).join(", ")]),
  ];
  return table(rows);
}

function formatTriggerList(list: TriggerList): string {
  const rows = [
    ["NAME", "WORKFLOW", "EVERY", "NEXT EXECUTION", "LAST CHECK"],
    ...list.items.map((trigger) => [trigger.name, trigger.workflow, formatDuration(trigger.schedule.every), trigger.suspended ? "suspended" : trigger.nextExecutionAt, formatEvaluation(trigger.lastEvaluation)]),
  ];
  return table(rows);
}

/** `succeeded <at>, <n> runs started` or `failed <at>: <why>`; empty before the first check. */
function formatEvaluation(evaluation: TriggerList["items"][number]["lastEvaluation"]): string {
  if (!evaluation) return "";
  if (evaluation.status === "failed") return `failed ${evaluation.at}${evaluation.message ? `: ${evaluation.message}` : ""}`;
  return `succeeded ${evaluation.at}, ${evaluation.startedRuns} ${evaluation.startedRuns === 1 ? "run" : "runs"} started`;
}

/** `{ minutes: 5, seconds: 30 }` as `5m30s`. */
function formatDuration(duration: Duration): string {
  const units = [["days", "d"], ["hours", "h"], ["minutes", "m"], ["seconds", "s"]] as const;
  return units.map(([unit, suffix]) => (duration[unit] ? `${duration[unit]}${suffix}` : "")).join("") || "0s";
}

function formatRun(run: Run): string {
  const describe = (error: WorkflowError) => `${error.instance}: ${error.title}${error.detail ? `: ${error.detail}` : ""}`;
  const fields = [
    ["RUN", run.id],
    ["WORKFLOW", run.workflow],
    ["STATUS", run.status],
    ...(run.startedBy ? [["STARTED BY", formatOrigin(run.startedBy, { url: true })]] : []),
    ["CREATED", run.createdAt],
    ["STARTED", run.startedAt ?? ""],
    ["FINISHED", run.finishedAt ?? ""],
    ...(run.error ? [["ERROR", describe(run.error)]] : []),
    ...(run.steps.some((step) => step.cost) ? [["COST", totalCost(run.steps.flatMap((step) => (step.cost ? [step.cost] : [])))]] : []),
  ];
  const steps = [
    ["STEP", "STATUS", "TASK", "COST", "STARTED", "FINISHED"],
    ...run.steps.map((step) => [
      step.reference,
      step.status,
      step.taskId ?? "",
      step.cost ? formatCost(step.cost) : "",
      step.startedAt,
      step.finishedAt ?? "",
    ]),
  ];
  const withTranscript = run.steps.filter((step) => step.transcript);
  const transcripts = withTranscript.length > 0 ? `\n${table([["STEP", "TRANSCRIPT"], ...withTranscript.map((step) => [step.reference, step.transcript!])])}` : "";
  return `${table(fields)}\n${table(steps)}${transcripts}${formatOutput(run.output)}`;
}

/** The run's output, one row per top-level field; single-line strings as they are, anything else as JSON. */
function formatOutput(output: unknown): string {
  if (output === undefined) return "";
  const entries: [string, unknown][] = output !== null && typeof output === "object" && !Array.isArray(output) ? Object.entries(output) : [["output", output]];
  if (entries.length === 0) return "";
  const rows = entries.map(([key, value]) => [key, typeof value === "string" && !/[\r\n]/.test(value) ? value : JSON.stringify(value)]);
  return `\n${table([["OUTPUT", "VALUE"], ...rows])}`;
}

const formatCost = ({ amount, currency }: Cost) => `${Number(amount.toFixed(4))} ${currency}`;

/** Sums costs per currency, e.g. "0.52 USD". */
function totalCost(costs: Cost[]): string {
  const sums = new Map<string, number>();
  for (const { amount, currency } of costs) sums.set(currency, (sums.get(currency) ?? 0) + amount);
  return [...sums].map(([currency, amount]) => formatCost({ amount, currency })).join(", ");
}

function formatNotificationList(list: NotificationList): string {
  const rows = [
    ["CREATED", "KIND", "RUN", "DELIVERY", "TITLE"],
    ...list.items.map((n) => [
      n.createdAt,
      n.kind,
      n.runId,
      n.delivery.error ? `${n.delivery.status}: ${n.delivery.error}` : n.delivery.status,
      n.title,
    ]),
  ];
  return table(rows);
}

function formatApprovalList(list: ApprovalRequestList): string {
  const rows = [
    ["ID", "STATUS", "RUN", "CREATED", "QUESTION"],
    ...list.items.map((request) => [request.id, request.status, request.runId, request.createdAt, request.question]),
  ];
  return table(rows);
}

/** Aligns cells in columns; the last column is not padded. */
function table(rows: string[][]): string {
  const columns = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, i) => Math.max(...rows.map((row) => (row[i] ?? "").length)));
  const lines = rows.map((row) => row.map((cell, i) => (i < row.length - 1 ? cell.padEnd(widths[i]! + 2) : cell)).join("").trimEnd());
  return `${lines.join("\n")}\n`;
}
