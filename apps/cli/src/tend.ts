import {
  followTranscript as followPlatformTranscript,
  formatCost,
  formatOrigin,
  formatSchedule,
  totalCost,
  TranscriptStreamRefusedError,
  TranscriptStreamUnreachableError,
  type FollowTranscriptOptions,
  type FollowTranscriptOutcome,
} from "@tendworks/platform";
import type { ControlPlane } from "@tendworks/shared";
import { Command, CommanderError, Option } from "commander";
import createClient, { type Client } from "openapi-fetch";
import { stringify as stringifyYaml } from "yaml";

type PlatformStatus = ControlPlane.components["schemas"]["PlatformStatus"];
type AccessScope = ControlPlane.components["schemas"]["Access"]["scope"];
type RunList = ControlPlane.components["schemas"]["RunList"];
type Run = ControlPlane.components["schemas"]["run"];
type WorkflowError = ControlPlane.components["schemas"]["workflowError"];
type TriggerList = ControlPlane.components["schemas"]["triggerList"];
type WorkspaceList = ControlPlane.components["schemas"]["WorkspaceList"];
type NotificationList = ControlPlane.components["schemas"]["NotificationList"];
type ApprovalRequestList = ControlPlane.components["schemas"]["ApprovalRequestList"];
type ApprovalRequest = ControlPlane.components["schemas"]["approvalRequest"];
type AgentList = ControlPlane.components["schemas"]["AgentList"];
type TranscriptEntry = ControlPlane.components["schemas"]["TranscriptEntryList"]["items"][number];
type Chat = ControlPlane.components["schemas"]["chat"];
type ChatList = ControlPlane.components["schemas"]["chatList"];

/** What `tend run logs` prints: the transcript of each agent step, absent where none was found. */
interface RunLogs {
  run: string;
  steps: { reference: string; status: Run["steps"][number]["status"]; taskId: string; entries?: TranscriptEntry[] }[];
}

/** Stable exit codes, so scripts and CI can rely on them. */
export const ExitCode = { ok: 0, error: 1, unhealthy: 2 } as const;

export interface TendIo {
  /** Transport to the control plane; defaults to the global fetch. */
  fetch?: (request: Request) => Promise<Response>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Waiting between polls and reconnects; replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** The lines the operator types, for interactive commands (`tend chat`); opened only when one runs. */
  lines?: () => AsyncIterableIterator<string>;
  /**
   * Hands Ctrl+C to an interactive command instead of ending the process, until the
   * returned function is called; registered only while one runs.
   */
  interrupts?: (onInterrupt: () => void) => () => void;
}

/** How often `--follow` looks for new steps and for the end of the run. */
const POLL_MS = 1000;
/** Attempts to reach a transcript stream in a row before `--follow` gives up. */
const CONNECT_ATTEMPTS = 5;

/** Runs one tend command line and resolves to its exit code. */
export async function runTend(args: string[], io: TendIo): Promise<number> {
  let exitCode: number = ExitCode.ok;
  const program = new Command("tend")
    .description("command line for the Tendworks agent platform")
    .addOption(
      new Option("--url <url>", "control plane URL").env("TEND_URL").default("http://localhost:8080"),
    )
    .addOption(new Option("--token <token>", "the platform's API token, or its read-only token for commands that only read").env("TEND_API_TOKEN"))
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
      const [{ data, error, response }, access] = await Promise.all([
        client.GET("/status").catch((cause: unknown) => {
          throw new UnreachableError(baseUrl, cause);
        }),
        // The token's access belongs to the table only; the status document stays the platform's.
        client.GET("/access").then(
          ({ data }) => data?.scope,
          () => undefined,
        ),
      ]);
      // 200 and 503 both carry a status document; anything else did not come from the control plane.
      const report: PlatformStatus | undefined = response.status === 200 || response.status === 503 ? (data ?? error) : undefined;
      if (!report?.components) throw new Error(`unexpected answer from the control plane (HTTP ${response.status})`);
      io.stdout(render(report, options.output, (document) => formatTable(document, access)));
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

  run
    .command("logs")
    .description("print the transcript of each agent step of a run, finished or running")
    .argument("<id>", "run id")
    .option("-f, --follow", "stream new entries of the run's agent steps as they come, until the run ends")
    .addOption(outputOption())
    .action(async (runId: string, options: { output: OutputFormat; follow?: boolean }, command: Command) => {
      const { baseUrl, client } = controlPlane(command);
      if (options.follow) {
        await followRun({ runId, client, baseUrl, output: options.output, io });
        return;
      }
      const unreachable = (cause: unknown) => {
        throw new UnreachableError(baseUrl, cause);
      };
      const { data: found, error, response } = await client.GET("/runs/{runId}", { params: { path: { runId } } }).catch(unreachable);
      if (response.status === 404) throw new Error(`run ${runId} not found`);
      if (!found) throw new AnswerError(response, error);
      const steps: RunLogs["steps"] = [];
      for (const { reference, status, taskId } of found.steps) {
        if (taskId === undefined) continue;
        const read = await client.GET("/runs/{runId}/tasks/{taskId}/transcript", { params: { path: { runId, taskId } } }).catch(unreachable);
        if (!read.data && read.response.status !== 404) throw new AnswerError(read.response, read.error);
        steps.push({ reference, status, taskId, ...(read.data ? { entries: read.data.items } : {}) });
      }
      io.stdout(render({ run: runId, steps }, options.output, formatRunLogs));
    });

  program
    .command("agent")
    .description("inspect agent profiles")
    .command("list")
    .description("list the configured agent profiles with their active agent sessions (count; -o json|yaml for the sessions)")
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

  program
    .command("workspace")
    .description("inspect workspaces")
    .command("list")
    .description("list the configured workspaces with their kind and assistant (tend chat --workspace <name>)")
    .addOption(outputOption())
    .action(async (options: { output: OutputFormat }, command: Command) => {
      const { baseUrl, client } = controlPlane(command);
      const { data, error, response } = await client.GET("/workspaces").catch((cause: unknown) => {
        throw new UnreachableError(baseUrl, cause);
      });
      if (!data) throw new AnswerError(response, error);
      io.stdout(render(data, options.output, formatWorkspaceList));
    });

  const notification = program.command("notification").description("inspect notifications");

  notification
    .command("list")
    .description("list notifications, newest first, with their first link and the delivery status per channel")
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

  approval
    .command("get")
    .description("show one approval request with its question, links and the answers to choose from")
    .argument("<id>", "approval request id")
    .addOption(outputOption())
    .action(async (id: string, options: { output: OutputFormat }, command: Command) => {
      const { baseUrl, client } = controlPlane(command);
      const { data, error, response } = await client.GET("/approval-requests/{approvalRequestId}", { params: { path: { approvalRequestId: id } } }).catch((cause: unknown) => {
        throw new UnreachableError(baseUrl, cause);
      });
      if (response.status === 404) throw new Error(`approval request ${id} not found`);
      if (!data) throw new AnswerError(response, error);
      io.stdout(render(data, options.output, formatApprovalRequest));
    });

  approval
    .command("answer")
    .description("decide an approval request with one of its answers; the waiting run continues or stops by it")
    .argument("<id>", "approval request id")
    .argument("<answer>", "the label of one of the request's answers (tend approval get <id>)")
    .action(async (id: string, answer: string, _options: unknown, command: Command) => {
      const { baseUrl, client } = controlPlane(command);
      const { data, error, response } = await client
        .POST("/approval-requests/{approvalRequestId}/decision", { params: { path: { approvalRequestId: id } }, body: { answer } })
        .catch((cause: unknown) => {
          throw new UnreachableError(baseUrl, cause);
        });
      if (response.status === 404) throw new Error(`approval request ${id} not found`);
      if (!data) throw new AnswerError(response, error);
      const outcome = data.answers.find((offered) => offered.label === data.answer)?.outcome;
      io.stdout(`approval request ${data.id} answered "${data.answer ?? answer}"; the run ${outcome === "stop" ? "stops" : "continues"}\n`);
    });

  const chat = program
    .command("chat")
    .description(
      "chat with the platform assistant, another agent profile that allows chats, or a workspace's assistant (--workspace); Ctrl+C cancels a running turn, and leaves the chat open while the agent waits (as Ctrl+D does); /end ends the chat",
    )
    .argument("[profile]", `agent profile that allows chats (default: ${PLATFORM_ASSISTANT}, the platform assistant)`)
    .option("--workspace <name>", "chat with the assistant of this workspace about its contents (tend workspace list shows those with one; read-only unless the workspace allows writing)")
    .action(async (profile: string | undefined, options: { workspace?: string }, command: Command) => {
      if (profile !== undefined && options.workspace !== undefined) {
        throw new Error("give either a profile or --workspace: a workspace's assistant is held with the profile its workspace names");
      }
      const { baseUrl, client } = controlPlane(command);
      const chatWith = options.workspace === undefined ? { agent: profile ?? PLATFORM_ASSISTANT } : { workspace: options.workspace };
      await startChat({ chatWith, client, baseUrl, io });
    });

  /** A chat by id, or a clear error when there is none. */
  const getChat = async (client: ControlPlaneClient, baseUrl: string, chatId: string): Promise<Chat> => {
    const { data, error, response } = await client.GET("/chats/{chatId}", { params: { path: { chatId } } }).catch((cause: unknown) => {
      throw new UnreachableError(baseUrl, cause);
    });
    if (response.status === 404) throw new Error(`chat ${chatId} not found`);
    if (!data) throw new AnswerError(response, error);
    return data;
  };

  chat
    .command("list")
    .description("list chats, the most recently started first, with profile, status, start, last activity and cost")
    .addOption(outputOption())
    .action(async (options: { output: OutputFormat }, command: Command) => {
      const { baseUrl, client } = controlPlane(command);
      const { data, error, response } = await client.GET("/chats").catch((cause: unknown) => {
        throw new UnreachableError(baseUrl, cause);
      });
      if (!data) throw new AnswerError(response, error);
      io.stdout(render(data, options.output, formatChatList));
    });

  chat
    .command("get")
    .description("show one chat")
    .argument("<id>", "chat id")
    .addOption(outputOption())
    .action(async (chatId: string, options: { output: OutputFormat }, command: Command) => {
      const { baseUrl, client } = controlPlane(command);
      io.stdout(render(await getChat(client, baseUrl, chatId), options.output, formatChat));
    });

  chat
    .command("attach")
    .description("print the history of a chat and continue it live, from any client; Ctrl+C cancels a running turn and leaves while the agent waits")
    .argument("<id>", "chat id")
    .action(async (chatId: string, _options: unknown, command: Command) => {
      const { baseUrl, client } = controlPlane(command);
      const found = await getChat(client, baseUrl, chatId);
      const terminal = chatTerminal(io);
      try {
        io.stdout(`chat ${chatId} with ${found.agent}${onWorkspace(found)} (${found.status}); type /end to end it\n`);
        await converse({ chatId, client, baseUrl, io, terminal, sent: [] });
      } finally {
        await terminal.close();
      }
    });

  chat
    .command("end")
    .description("end a chat for good; its transcript stays readable")
    .argument("<id>", "chat id")
    .action(async (chatId: string, _options: unknown, command: Command) => {
      const { baseUrl, client } = controlPlane(command);
      const { data, error, response } = await client.POST("/chats/{chatId}/end", { params: { path: { chatId } } }).catch((cause: unknown) => {
        throw new UnreachableError(baseUrl, cause);
      });
      if (response.status === 404) throw new Error(`chat ${chatId} not found`);
      if (!data) throw new AnswerError(response, error);
      io.stdout(`chat ${chatId} ended\n`);
    });

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
      super("the control plane refused the token (HTTP 401); set TEND_API_TOKEN or pass --token");
      return;
    }
    if (response.status === 403 && problem?.detail) {
      super(`the control plane refused the operation (HTTP 403): ${problem.detail}`);
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

/** `access`: what the presented token may do; undefined without a valid one (shown as `none`). */
function formatTable(report: PlatformStatus, access: AccessScope | undefined): string {
  const rows = [["COMPONENT", "STATUS", "MESSAGE"], ...report.components.map((c) => [c.name, c.status, c.message ?? ""])];
  const active = report.activeRuns === undefined ? "" : `ACTIVE RUNS  ${report.activeRuns}\n`;
  const pending = report.pendingApprovals === undefined ? "" : `PENDING APPROVALS  ${report.pendingApprovals}\n`;
  return `PLATFORM  ${report.status}\n${active}${pending}ACCESS  ${access ?? "none"}\n\n${table(rows)}`;
}

function formatRunList(list: RunList): string {
  const rows = [
    ["ID", "WORKFLOW", "STATUS", "STARTED BY", "CREATED", "FINISHED"],
    ...list.items.map((run) => [run.id, run.workflow, run.status, formatOrigin(run.startedBy), run.createdAt, run.finishedAt ?? ""]),
  ];
  return table(rows);
}

function formatAgentList(list: AgentList): string {
  const rows = [
    ["NAME", "HARNESS", "SANDBOX", "SKILLS", "SESSIONS"],
    ...list.items.map((agent) => [agent.name, agent.harness, agent.sandbox ?? "", (agent.skills ?? []).join(", "), agent.sessions ? String(agent.sessions.length) : "?"]),
  ];
  return table(rows);
}

function formatChatList(list: ChatList): string {
  const rows = [
    ["ID", "AGENT", "WORKSPACE", "STATUS", "STARTED", "LAST ACTIVITY", "COST"],
    ...list.items.map((chat) => [chat.id, chat.agent, chat.workspace ?? "-", chat.status, chat.startedAt, chat.lastActivityAt, chat.cost ? formatCost(chat.cost) : ""]),
  ];
  return table(rows);
}

function formatWorkspaceList(list: WorkspaceList): string {
  const assistantOf = ({ assistant }: WorkspaceList["items"][number]) => (assistant ? `${assistant.profile} (${assistant.write ? "may write" : "read-only"})` : "-");
  return table([["NAME", "KIND", "ASSISTANT"], ...list.items.map((workspace) => [workspace.name, workspace.kind, assistantOf(workspace)])]);
}

/** ` on workspace <name> (read-only)` for a chat with a workspace's assistant; empty otherwise. */
function onWorkspace(chat: Chat): string {
  return chat.workspace === undefined ? "" : ` on workspace ${chat.workspace} (${chat.write ? "may write" : "read-only"})`;
}

function formatChat(chat: Chat): string {
  const fields = [
    ["CHAT", chat.id],
    ["AGENT", chat.agent],
    ...(chat.workspace ? [["WORKSPACE", `${chat.workspace} (${chat.write ? "may write" : "read-only"})`]] : []),
    ["STATUS", chat.status],
    ["STARTED", chat.startedAt],
    ["LAST ACTIVITY", chat.lastActivityAt],
    ...(chat.endedAt ? [["ENDED", chat.endedAt]] : []),
    ...(chat.cost ? [["COST", formatCost(chat.cost)]] : []),
    ...(chat.transcript ? [["TRANSCRIPT", chat.transcript]] : []),
  ];
  const width = Math.max(...fields.map(([label]) => label!.length), "MESSAGE".length) + 2;
  // The agent's last answer, or why the chat failed; text over several lines continues under the first.
  const message = chat.message ? `${"MESSAGE".padEnd(width)}${chat.message.replaceAll("\n", `\n${" ".repeat(width)}`)}\n` : "";
  return `${table(fields.map(([label, value]) => [label!.padEnd(width - 2), value!]))}${message}`;
}

function formatTriggerList(list: TriggerList): string {
  const rows = [
    ["NAME", "WORKFLOW", "TRIGGER", "WORKSPACES", "SCHEDULE", "NEXT EXECUTION", "LAST CHECK"],
    ...list.items.map((trigger) => [
      trigger.name,
      trigger.workflow,
      trigger.kind,
      trigger.workspaces.join(",") || "-",
      formatSchedule(trigger.schedule),
      trigger.suspended ? "suspended" : trigger.nextExecutionAt,
      formatEvaluation(trigger.lastEvaluation),
    ]),
  ];
  return table(rows);
}

/** `succeeded <at>, <n> runs started` or `failed <at>: <why>`; empty before the first check. */
function formatEvaluation(evaluation: TriggerList["items"][number]["lastEvaluation"]): string {
  if (!evaluation) return "";
  if (evaluation.status === "failed") return `failed ${evaluation.at}${evaluation.message ? `: ${evaluation.message}` : ""}`;
  return `succeeded ${evaluation.at}, ${evaluation.startedRuns} ${evaluation.startedRuns === 1 ? "run" : "runs"} started`;
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
  const artifacts = run.steps.flatMap((step) => (step.artifacts ?? []).map((artifact) => [step.reference, artifact.name, artifact.url]));
  const reported = artifacts.length > 0 ? `\n${table([["STEP", "ARTIFACT", "URL"], ...artifacts])}` : "";
  return `${table(fields)}\n${table(steps)}${transcripts}${reported}${formatOutput(run.output)}`;
}

/** The run's output, one row per top-level field; single-line strings as they are, anything else as JSON. */
function formatOutput(output: unknown): string {
  if (output === undefined) return "";
  const entries: [string, unknown][] = output !== null && typeof output === "object" && !Array.isArray(output) ? Object.entries(output) : [["output", output]];
  if (entries.length === 0) return "";
  const rows = entries.map(([key, value]) => [key, typeof value === "string" && !/[\r\n]/.test(value) ? value : JSON.stringify(value)]);
  return `\n${table([["OUTPUT", "VALUE"], ...rows])}`;
}

function formatRunLogs({ run, steps }: RunLogs): string {
  if (steps.length === 0) return `run ${run} has no agent steps yet\n`;
  return steps
    .map(({ reference, status, taskId, entries }) => {
      const lines = entries ? formatTranscript(entries) : ["(no transcript)"];
      return [`== ${reference} (${taskId}, ${status})`, ...lines].map((line) => `${line}\n`).join("");
    })
    .join("\n");
}

type ControlPlaneClient = Client<ControlPlane.paths>;

const TERMINAL_RUN: ReadonlySet<Run["status"]> = new Set(["completed", "failed"]);

/** Waiting as `io` does it: as a test says, or for real. */
const sleepOf = (io: TendIo) => io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/**
 * Follows a transcript stream with the platform library (ADR 0017), turning its errors
 * into the CLI's: an unreachable stream into `unreachable`, a refusal into an answer error.
 */
async function followTranscript({
  unreachable,
  ...follow
}: Omit<FollowTranscriptOptions<TranscriptEntry>, "retryMs" | "attempts"> & { unreachable: (cause: unknown) => never }): Promise<FollowTranscriptOutcome> {
  try {
    return await followPlatformTranscript({ ...follow, retryMs: POLL_MS, attempts: CONNECT_ATTEMPTS });
  } catch (error) {
    if (error instanceof TranscriptStreamUnreachableError) unreachable(error.cause);
    if (error instanceof TranscriptStreamRefusedError) throw new AnswerError(error.response, error.problem as { title?: string; detail?: string } | undefined);
    throw error;
  }
}

/**
 * `tend run logs --follow`: the agent steps of a run one after another, each streamed
 * live (ADR 0017) until its task ends, until the run ends. A broken stream is resumed
 * with `Last-Event-ID`, so no entry is missed or printed twice. Once the run has ended,
 * what is left of a step is read from its transcript instead of waiting for its stream.
 */
async function followRun({ runId, client, baseUrl, output, io }: { runId: string; client: ControlPlaneClient; baseUrl: string; output: OutputFormat; io: TendIo }) {
  const sleep = sleepOf(io);
  const unreachable = (cause: unknown): never => {
    throw new UnreachableError(baseUrl, cause);
  };
  const getRun = async () => {
    const { data, error, response } = await client.GET("/runs/{runId}", { params: { path: { runId } } }).catch(unreachable);
    if (response.status === 404) throw new Error(`run ${runId} not found`);
    if (!data) throw new AnswerError(response, error);
    return data;
  };
  const printer = entryPrinter(io.stdout, output);

  /** Streams a step's transcript after `last` until its task ends or the run ends. */
  async function followStep(taskId: string, print: (entry: TranscriptEntry) => void, last: () => number): Promise<"ended" | "run-ended" | "missing"> {
    const stop = new AbortController();
    let following = true;
    void (async () => {
      while (following) {
        await sleep(POLL_MS);
        if (!following) return;
        const run = await getRun().catch(() => undefined);
        if (run && TERMINAL_RUN.has(run.status)) stop.abort();
      }
    })();
    try {
      const outcome = await followTranscript({
        open: (header, signal) => client.GET("/runs/{runId}/tasks/{taskId}/transcript/stream", { params: { path: { runId, taskId }, header }, parseAs: "stream", signal }),
        after: last(),
        signal: stop.signal,
        sleep,
        unreachable,
        onEntry: print,
      });
      return outcome === "stopped" ? "run-ended" : outcome;
    } finally {
      following = false;
    }
  }

  /** What is left of a step's transcript after `last`; false if it has none. */
  async function readRest(taskId: string, print: (entry: TranscriptEntry) => void, last: number): Promise<boolean> {
    const { data, error, response } = await client.GET("/runs/{runId}/tasks/{taskId}/transcript", { params: { path: { runId, taskId } } }).catch(unreachable);
    if (response.status === 404) return false;
    if (!data) throw new AnswerError(response, error);
    for (const entry of data.items) if (entry.position > last) print(entry);
    return true;
  }

  const followed = new Set<string>();
  let run = await getRun();
  for (;;) {
    const ended = TERMINAL_RUN.has(run.status);
    const step = run.steps.find((candidate) => candidate.taskId !== undefined && !followed.has(`${candidate.reference} ${candidate.taskId}`));
    if (!step) {
      if (ended) return;
      await sleep(POLL_MS);
      run = await getRun();
      continue;
    }
    const taskId = step.taskId!;
    followed.add(`${step.reference} ${taskId}`);
    printer.step(step.reference, taskId);
    let last = -1;
    const print = (entry: TranscriptEntry) => {
      last = entry.position;
      printer.entry(entry);
    };
    const outcome = ended ? "run-ended" : await followStep(taskId, print, () => last);
    const found = outcome === "run-ended" ? await readRest(taskId, print, last) : outcome === "ended";
    if (!found) printer.missing();
    printer.endStep();
    if (!ended) run = await getRun();
  }
}

/** Lines the operator types in `tend chat` that are no message to the agent. */
const END_CHAT = "/end";

/**
 * What happens during an interactive chat, in order: the operator types a line (undefined
 * at the end of input) or presses Ctrl+C; the transcript gains an entry, the chat ends,
 * or following it failed.
 */
type ChatEvent =
  | { kind: "line"; text: string | undefined }
  | { kind: "interrupt" }
  | { kind: "entry"; entry: TranscriptEntry }
  | { kind: "ended" }
  | { kind: "failed"; error: unknown };

/**
 * The operator's side of an interactive chat: typed lines (read one at a time, only when
 * asked for) and Ctrl+C, as events of one sequence that the chat's transcript joins, so
 * neither blocks the other.
 */
function chatTerminal(io: TendIo) {
  const events = queue<ChatEvent>();
  const lines = io.lines?.() ?? (async function* () {})();
  let reading = false;
  const stopInterrupts = io.interrupts?.(() => events.push({ kind: "interrupt" })) ?? (() => {});
  return {
    events,
    /** Reads the next line, unless a read is pending already. */
    read() {
      if (reading) return;
      reading = true;
      void lines.next().then(
        (next) => {
          reading = false;
          events.push({ kind: "line", text: next.done ? undefined : next.value });
        },
        () => events.push({ kind: "line", text: undefined }),
      );
    },
    async close() {
      stopInterrupts();
      await lines.return?.();
    },
  };
}

type ChatTerminal = ReturnType<typeof chatTerminal>;

/** Events in the order they happen, taken one at a time. */
function queue<T>() {
  const queued: T[] = [];
  const waiting: ((event: T) => void)[] = [];
  return {
    push(event: T) {
      const taker = waiting.shift();
      if (taker) taker(event);
      else queued.push(event);
    },
    next(): Promise<T> {
      return queued.length > 0 ? Promise.resolve(queued.shift()!) : new Promise((resolve) => waiting.push(resolve));
    },
  };
}

/** The chat profile `tend chat` without arguments talks to. */
const PLATFORM_ASSISTANT = "assistant";

/**
 * `tend chat [profile]` and `tend chat --workspace <name>`: an interactive chat (ADR 0015)
 * with an agent profile or a workspace's assistant (ADR 0022). The first line starts the
 * chat, which then goes on as in {@link converse}.
 */
async function startChat({
  chatWith,
  client,
  baseUrl,
  io,
}: {
  chatWith: { agent: string } | { workspace: string };
  client: ControlPlaneClient;
  baseUrl: string;
  io: TendIo;
}) {
  const terminal = chatTerminal(io);
  try {
    let first: string | undefined;
    while (first === undefined) {
      io.stdout("> ");
      terminal.read();
      const event = await terminal.events.next();
      // Ctrl+C or the end of input before the first message: no chat.
      if (event.kind !== "line" || event.text === undefined) {
        io.stdout("\n");
        return;
      }
      if (event.text.trim() !== "") first = event.text.trim();
    }
    const started = await client.POST("/chats", { body: { ...chatWith, text: first } }).catch((cause: unknown) => {
      throw new UnreachableError(baseUrl, cause);
    });
    if (!started.data) {
      if (started.response.status === 400 && started.error?.detail) throw new Error(started.error.detail);
      throw new AnswerError(started.response, started.error);
    }
    io.stdout(`chat ${started.data.id} with ${started.data.agent}${onWorkspace(started.data)}; type /end to end it\n`);
    await converse({ chatId: started.data.id, client, baseUrl, io, terminal, sent: [first] });
  } finally {
    await terminal.close();
  }
}

const textOf = (message: { parts: ({ text: string } | object)[] }) => message.parts.flatMap((part) => ("text" in part ? [part.text] : [])).join(" ");

/**
 * An interactive chat from this client (ADR 0015): the history first, then the chat's
 * transcript live (ADR 0017), whoever wrote to it; once the agent waits, the next line
 * goes to the agent. All state is on the platform, so any number of clients can do this
 * at once, and any of them can send the next message. Ctrl+C cancels a running turn;
 * while the agent waits, Ctrl+C or the end of input leaves the chat open; `/end` ends
 * it. A broken stream is resumed with `Last-Event-ID`.
 */
async function converse({
  chatId,
  client,
  baseUrl,
  io,
  terminal,
  sent,
}: {
  chatId: string;
  client: ControlPlaneClient;
  baseUrl: string;
  io: TendIo;
  terminal: ChatTerminal;
  /** Messages this client sent whose echo in the transcript is not printed again, as they are on the screen already. */
  sent: string[];
}) {
  const sleep = sleepOf(io);
  const unreachable = (cause: unknown): never => {
    throw new UnreachableError(baseUrl, cause);
  };
  const of = { params: { path: { chatId } } };
  const { events } = terminal;
  const stop = new AbortController();

  // A prompt waits on its line; whatever is printed next starts on a line of its own.
  let prompted = false;
  const write = (text: string) => {
    if (prompted) io.stdout("\n");
    prompted = false;
    io.stdout(text);
  };
  const prompt = () => {
    if (!prompted) io.stdout("> ");
    prompted = true;
    terminal.read();
  };
  const printer = entryPrinter(write, "table");

  /** The transcript so far; the position of its last entry. */
  const history = async (): Promise<number> => {
    const { data, error, response } = await client.GET("/chats/{chatId}/transcript", of).catch(unreachable);
    if (response.status === 404) throw new Error(`chat ${chatId} not found`);
    if (!data) throw new AnswerError(response, error);
    for (const entry of data.items) events.push({ kind: "entry", entry });
    return data.items.at(-1)?.position ?? -1;
  };

  /** Follows the transcript live after `last`, as events, until the chat ends or this client leaves. */
  const follow = async (last: number) => {
    const outcome = await followTranscript({
      open: (header, signal) => client.GET("/chats/{chatId}/transcript/stream", { params: { path: { chatId }, header }, parseAs: "stream", signal }),
      after: last,
      signal: stop.signal,
      sleep,
      unreachable,
      onEntry: (entry) => events.push({ kind: "entry", entry }),
    });
    if (outcome === "missing") throw new Error(`chat ${chatId} not found`);
    if (outcome === "ended") events.push({ kind: "ended" });
  };

  /** Asks the agent to stop the running turn; the transcript shows when it did. */
  const cancel = () =>
    void client.POST("/chats/{chatId}/cancel", of).then(
      ({ data, error, response }) => {
        // A turn that ended meanwhile, or a chat another client ended, needs no cancel.
        if (!data && response.status !== 409) events.push({ kind: "failed", error: new AnswerError(response, error) });
      },
      (cause: unknown) => events.push({ kind: "failed", error: new UnreachableError(baseUrl, cause) }),
    );

  try {
    void history()
      .then(follow)
      .catch((error: unknown) => events.push({ kind: "failed", error }));
    let waiting = false;
    let cancelling = false;
    for (;;) {
      const event = await events.next();
      switch (event.kind) {
        case "failed":
          throw event.error;
        case "ended":
          printer.endStep();
          write(`chat ${chatId} has ended\n`);
          return;
        case "entry": {
          const { entry } = event;
          if (entry.type === "task-started" || entry.type === "message-received") {
            waiting = false;
            const own = sent.indexOf(textOf(entry.message));
            if (own >= 0) sent.splice(own, 1);
            else printer.entry(entry);
          } else if (entry.type === "input-required") {
            printer.endStep();
            if (entry.cost) write(`(${formatCost(entry.cost)} so far)\n`);
            waiting = true;
            cancelling = false;
            prompt();
          } else {
            printer.entry(entry);
          }
          break;
        }
        case "interrupt":
          if (waiting || cancelling) {
            // Ctrl+C while the agent waits, or a second one while a cancel is under way: leave.
            prompted = true;
            write(`left chat ${chatId}; it stays open\n`);
            return;
          }
          cancelling = true;
          write("cancelling the turn; Ctrl+C again leaves the chat open\n");
          cancel();
          break;
        case "line": {
          prompted = false;
          if (event.text === undefined) {
            io.stdout(`\nleft chat ${chatId}; it stays open\n`);
            return;
          }
          const text = event.text.trim();
          if (text === END_CHAT) {
            const ended = await client.POST("/chats/{chatId}/end", of).catch(unreachable);
            if (!ended.data) throw new AnswerError(ended.response, ended.error);
            io.stdout(`chat ${chatId} ended\n`);
            return;
          }
          if (text !== "") {
            const answer = await client.POST("/chats/{chatId}/messages", { ...of, body: { text } }).catch(unreachable);
            if (answer.data) {
              sent.push(text);
              waiting = false;
            } else if (answer.response.status === 409) {
              io.stderr(`tend: ${answer.error?.detail ?? "the chat cannot take a message now"}\n`);
            } else {
              throw new AnswerError(answer.response, answer.error);
            }
          }
          if (waiting) prompt();
          break;
        }
      }
    }
  } finally {
    stop.abort();
  }
}

/**
 * Prints entries one at a time as they arrive: as lines like `tend run logs`, where the
 * chunks of a message continue on the line they started, or as one JSON or YAML
 * document per entry.
 */
function entryPrinter(write: (text: string) => void, format: OutputFormat) {
  let current = { step: "", taskId: "" };
  let steps = 0;
  let open: "message-chunk" | "thought-chunk" | undefined;
  const indent = (text: string) => text.replaceAll("\n", `\n${" ".repeat(21)}`);
  const endLine = () => {
    if (open) write("\n");
    open = undefined;
  };
  return {
    step(step: string, taskId: string) {
      current = { step, taskId };
      if (format === "table") write(`${steps > 0 ? "\n" : ""}== ${step} (${taskId})\n`);
      steps++;
    },
    entry(entry: TranscriptEntry) {
      if (format === "json") return write(`${JSON.stringify({ ...current, entry })}\n`);
      if (format === "yaml") return write(`---\n${stringifyYaml({ ...current, entry })}`);
      if (entry.type === "message-chunk" || entry.type === "thought-chunk") {
        if (open === entry.type) return write(indent(entry.text));
        endLine();
        open = entry.type;
        return write(`${entry.time.slice(11, 19)}  ${(entry.type === "message-chunk" ? "agent" : "thinking").padEnd(10)} ${indent(entry.text.trimStart())}`);
      }
      endLine();
      write(formatTranscript([entry]).map((line) => `${line}\n`).join(""));
    },
    missing() {
      if (format === "table") write("(no transcript)\n");
    },
    endStep: endLine,
  };
}

/**
 * One line per entry: time, what happened, details; consecutive message and thought
 * chunks are joined, and text over several lines continues under the details.
 */
function formatTranscript(entries: TranscriptEntry[]): string[] {
  const lines: string[] = [];
  const line = (time: string, label: string, text: string) => {
    const [first = "", ...rest] = text.split("\n");
    lines.push(`${time.slice(11, 19)}  ${label.padEnd(10)} ${first}`.trimEnd(), ...rest.map((more) => `${" ".repeat(21)}${more}`.trimEnd()));
  };
  const harness = (info?: { name: string; version?: string }) => (info ? ` (${[info.name, info.version].filter(Boolean).join(" ")})` : "");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    switch (entry.type) {
      case "message-chunk":
      case "thought-chunk": {
        let text = entry.text;
        while (entries[index + 1]?.type === entry.type) text += (entries[++index] as typeof entry).text;
        line(entry.time, entry.type === "message-chunk" ? "agent" : "thinking", text.trim());
        break;
      }
      case "task-started":
        line(entry.time, "task", `${entry.agent}: ${entry.message.parts.flatMap((part) => ("text" in part ? [part.text] : [])).join(" ")}`);
        break;
      case "task-resumed":
        line(entry.time, "resumed", "task after an interruption");
        break;
      case "task-ended":
        line(entry.time, "ended", `${entry.state}: ${entry.message}${entry.cost ? ` (${formatCost(entry.cost)})` : ""}`);
        break;
      case "message-received":
        line(entry.time, "human", entry.message.parts.flatMap((part) => ("text" in part ? [part.text] : [])).join(" "));
        break;
      case "input-required":
        line(entry.time, "waiting", `for the next message${entry.cost ? ` (${formatCost(entry.cost)} so far)` : ""}`);
        break;
      case "session-started":
        line(entry.time, "session", `started ${entry.sessionId}${harness(entry.harness)}`);
        break;
      case "session-resumed":
        line(entry.time, "session", `resumed ${entry.sessionId}${harness(entry.harness)}`);
        break;
      case "session-resume-failed":
        line(entry.time, "session", `could not resume ${entry.sessionId}: ${entry.reason}`);
        break;
      case "tool-call":
        line(entry.time, "tool", `${entry.title}${entry.kind ? ` [${entry.kind}]` : ""}`);
        break;
      case "tool-result":
        line(entry.time, "result", `${entry.status}${entry.output ? `: ${entry.output}` : ""}`);
        break;
      case "permission":
        line(entry.time, "permission", `${entry.granted ? "granted" : "refused"}: ${entry.tool}`);
        break;
      case "plan":
        line(entry.time, "plan", entry.steps.map((step) => `[${step.status}] ${step.content}`).join("\n"));
        break;
      case "usage":
        line(entry.time, "usage", `${formatCost(entry.cost)} so far`);
        break;
      case "turn-ended":
        line(entry.time, "turn", entry.reason);
        break;
      case "workspace-checkout":
        line(entry.time, "checkout", `${[entry.workspace.url, entry.workspace.branch].filter(Boolean).join(" ")} (exit code ${entry.exitCode})${entry.output ? `\n${entry.output}` : ""}`);
        break;
      case "artifacts":
        for (const artifact of entry.artifacts) line(entry.time, "artifact", `${artifact.name} ${artifact.url}`);
        break;
      case "artifacts-ignored":
        line(entry.time, "ignored", entry.problem);
        break;
      case "harness-output":
        line(entry.time, "harness", entry.text);
        break;
      case "error":
        line(entry.time, "error", entry.message);
        break;
    }
  }
  return lines;
}

function formatNotificationList(list: NotificationList): string {
  const rows = [
    ["CREATED", "KIND", "RUN", "LINK", "DELIVERY", "TITLE"],
    ...list.items.map((n) => [
      n.createdAt,
      n.kind,
      n.runId ?? "-",
      n.artifacts?.[0]?.url ?? "-",
      n.deliveries.map(({ channel, status }) => `${channel} ${status}`).join(", ") || "no channel",
      n.title,
    ]),
  ];
  // Reasons are long; they follow the table, one line per failed delivery.
  const failures = list.items.flatMap((n) =>
    n.deliveries.flatMap(({ channel, status, error }) => (status === "failed" ? [`${channel} failed for ${n.id}: ${error ?? "no reason given"}`] : [])),
  );
  return failures.length === 0 ? table(rows) : `${table(rows)}\n${failures.join("\n")}\n`;
}

function formatApprovalList(list: ApprovalRequestList): string {
  const rows = [
    ["ID", "STATUS", "RUN", "CREATED", "ANSWER", "QUESTION"],
    ...list.items.map((request) => [request.id, request.status, request.runId, request.createdAt, request.answer ?? "-", request.question]),
  ];
  return table(rows);
}

function formatApprovalRequest(request: ApprovalRequest): string {
  const fields = [
    ["APPROVAL REQUEST", request.id],
    ["RUN", request.runId],
    ["WORKFLOW", request.workflow],
    ["STEP", request.step],
    ["ACTION", request.action],
    ["POLICY", request.policy ?? "- (no policy applies, so the platform asks)"],
    ["STATUS", request.status],
    ["CREATED", request.createdAt],
    ...(request.answer ? [["DECIDED", `${request.answer}${request.decidedAt ? ` (${request.decidedAt})` : ""}`]] : []),
    ["QUESTION", request.question],
  ];
  const links = request.links.length > 0 ? `\n${table([["LINK", "URL"], ...request.links.map((link) => [link.title, link.url])])}` : "";
  const answers = table([["ANSWER", "THEN"], ...request.answers.map((answer) => [answer.label, answer.outcome])]);
  const hint = request.status === "pending" ? `\nAnswer with: tend approval answer ${request.id} "<answer>"\n` : "";
  return `${table(fields)}${links}\n${answers}${hint}`;
}

/** Aligns cells in columns; the last column is not padded. */
function table(rows: string[][]): string {
  const columns = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, i) => Math.max(...rows.map((row) => (row[i] ?? "").length)));
  const lines = rows.map((row) => row.map((cell, i) => (i < row.length - 1 ? cell.padEnd(widths[i]! + 2) : cell)).join("").trimEnd());
  return `${lines.join("\n")}\n`;
}
