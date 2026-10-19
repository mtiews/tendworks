import { readServerSentEvents } from "@tendworks/platform";
import type { ControlPlane } from "@tendworks/shared";
import { Command, CommanderError, Option } from "commander";
import createClient, { type Client } from "openapi-fetch";
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
type TranscriptEntry = ControlPlane.components["schemas"]["TranscriptEntryList"]["items"][number];

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

  program
    .command("chat")
    .description("chat with an agent profile that allows chats; /end ends the chat, an empty input (Ctrl+D) leaves it open")
    .argument("<profile>", "agent profile")
    .action(async (agent: string, _options: unknown, command: Command) => {
      const { baseUrl, client } = controlPlane(command);
      await chat({ agent, client, baseUrl, io });
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
    ["NAME", "HARNESS", "SANDBOX", "SKILLS", "SESSIONS"],
    ...list.items.map((agent) => [agent.name, agent.harness, agent.sandbox ?? "", (agent.skills ?? []).join(", "), String(agent.sessions.length)]),
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

/**
 * `tend run logs --follow`: the agent steps of a run one after another, each streamed
 * live (ADR 0017) until its task ends, until the run ends. A broken stream is resumed
 * with `Last-Event-ID`, so no entry is missed or printed twice. Once the run has ended,
 * what is left of a step is read from its transcript instead of waiting for its stream.
 */
async function followRun({ runId, client, baseUrl, output, io }: { runId: string; client: ControlPlaneClient; baseUrl: string; output: OutputFormat; io: TendIo }) {
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
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
    const runEnded = new Promise<"run-ended">((resolve) => stop.signal.addEventListener("abort", () => resolve("run-ended"), { once: true }));
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
      for (let failures = 0; ; ) {
        let answer;
        try {
          answer = await client.GET("/runs/{runId}/tasks/{taskId}/transcript/stream", {
            params: { path: { runId, taskId }, header: last() < 0 ? {} : { "Last-Event-ID": String(last()) } },
            parseAs: "stream",
            signal: stop.signal,
          });
        } catch (cause) {
          if (stop.signal.aborted) return "run-ended";
          if (++failures >= CONNECT_ATTEMPTS) unreachable(cause);
          await sleep(POLL_MS);
          continue;
        }
        const { data, error, response } = answer;
        if (response.status === 404) return "missing";
        if (!response.ok || !data) throw new AnswerError(response, error);
        const events = readServerSentEvents(data);
        try {
          for (;;) {
            const next = await Promise.race([events.next(), runEnded]);
            if (next === "run-ended") {
              void events.return(undefined);
              return next;
            }
            if (next.done) break;
            failures = 0;
            if (next.value.event === "end") return "ended";
            if (next.value.event === "entry") print(JSON.parse(next.value.data) as TranscriptEntry);
          }
        } catch {
          // The connection broke; resumed below.
        }
        if (stop.signal.aborted) return "run-ended";
        if (++failures >= CONNECT_ATTEMPTS) unreachable(new Error("the transcript stream broke off"));
        await sleep(POLL_MS);
      }
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
 * `tend chat <profile>`: an interactive chat (ADR 0015). The first line starts the chat,
 * then the agent's output streams live (ADR 0017) until its turn ends (`input-required`)
 * and the next line goes to the agent. All state is on the platform: leaving (end of
 * input) keeps the chat open, `/end` ends it. A broken stream is resumed with
 * `Last-Event-ID`.
 */
async function chat({ agent, client, baseUrl, io }: { agent: string; client: ControlPlaneClient; baseUrl: string; io: TendIo }) {
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const unreachable = (cause: unknown): never => {
    throw new UnreachableError(baseUrl, cause);
  };
  const lines = io.lines?.() ?? (async function* () {})();
  /** The next line with text, or undefined when the operator left. */
  const ask = async (): Promise<string | undefined> => {
    for (;;) {
      io.stdout("> ");
      const next = await lines.next();
      if (next.done) {
        io.stdout("\n");
        return undefined;
      }
      const text = next.value.trim();
      if (text !== "") return text;
    }
  };

  try {
    const first = await ask();
    if (first === undefined) return;
    const started = await client.POST("/chats", { body: { agent, text: first } }).catch(unreachable);
    if (!started.data) {
      if (started.response.status === 400 && started.error?.detail) throw new Error(started.error.detail);
      throw new AnswerError(started.response, started.error);
    }
    const chatId = started.data.id;
    const of = { params: { path: { chatId } } };
    io.stdout(`chat ${chatId} with ${agent}; type /end to end it, Ctrl+D to leave it open\n`);

    /** The operator's next message, sent; "left" or "ended" when there is none. */
    const answerTurn = async (): Promise<"sent" | "left" | "ended"> => {
      for (;;) {
        const text = await ask();
        if (text === undefined) {
          io.stdout(`left chat ${chatId}; it stays open\n`);
          return "left";
        }
        if (text === END_CHAT) {
          const ended = await client.POST("/chats/{chatId}/end", of).catch(unreachable);
          if (!ended.data) throw new AnswerError(ended.response, ended.error);
          io.stdout(`chat ${chatId} ended\n`);
          return "ended";
        }
        const sent = await client.POST("/chats/{chatId}/messages", { ...of, body: { text } }).catch(unreachable);
        if (sent.data) return "sent";
        if (sent.response.status !== 409) throw new AnswerError(sent.response, sent.error);
        io.stderr(`tend: ${sent.error?.detail ?? "the chat cannot take a message now"}\n`);
        if (sent.error?.title === "Chat ended") return "ended";
      }
    };

    const printer = entryPrinter(io.stdout, "table");
    let last = -1;
    for (let failures = 0; ; ) {
      let answer;
      try {
        answer = await client.GET("/chats/{chatId}/transcript/stream", {
          params: { path: { chatId }, header: last < 0 ? {} : { "Last-Event-ID": String(last) } },
          parseAs: "stream",
        });
      } catch (cause) {
        if (++failures >= CONNECT_ATTEMPTS) unreachable(cause);
        await sleep(POLL_MS);
        continue;
      }
      if (!answer.response.ok || !answer.data) throw new AnswerError(answer.response, answer.error);
      const events = readServerSentEvents(answer.data);
      for (;;) {
        let next;
        try {
          next = await events.next();
        } catch {
          break; // The connection broke; resumed below.
        }
        if (next.done) break;
        failures = 0;
        if (next.value.event === "end") {
          printer.endStep();
          return;
        }
        if (next.value.event !== "entry") continue;
        const entry = JSON.parse(next.value.data) as TranscriptEntry;
        last = entry.position;
        // The operator's own messages are on the screen already.
        if (entry.type === "task-started" || entry.type === "message-received") continue;
        if (entry.type !== "input-required") {
          printer.entry(entry);
          continue;
        }
        printer.endStep();
        if (entry.cost) io.stdout(`(${formatCost(entry.cost)} so far)\n`);
        if ((await answerTurn()) !== "sent") {
          void events.return(undefined);
          return;
        }
      }
      if (++failures >= CONNECT_ATTEMPTS) unreachable(new Error("the transcript stream broke off"));
      await sleep(POLL_MS);
    }
  } finally {
    await lines.return?.();
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
        line(entry.time, "checkout", `${entry.workspace.repository} ${entry.workspace.branch} (exit code ${entry.exitCode})${entry.output ? `\n${entry.output}` : ""}`);
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
