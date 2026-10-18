import type { ControlPlane } from "@tendworks/shared";
import { Command, CommanderError, Option } from "commander";
import createClient from "openapi-fetch";
import { stringify as stringifyYaml } from "yaml";

type PlatformStatus = ControlPlane.components["schemas"]["PlatformStatus"];

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
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  const controlPlane = (command: Command) => {
    const baseUrl: string = command.optsWithGlobals().url;
    return { baseUrl, client: createClient<ControlPlane.paths>({ baseUrl, ...(io.fetch ? { fetch: io.fetch } : {}) }) };
  };

  program
    .command("status")
    .description("show platform health")
    .addOption(outputOption())
    .action(async (options: { output: OutputFormat }, command: Command) => {
      const { baseUrl, client } = controlPlane(command);
      const { data, error } = await client.GET("/status").catch((cause: unknown) => {
        throw new UnreachableError(baseUrl, cause);
      });
      const status = (data ?? error) as PlatformStatus;
      io.stdout(render(status, options.output, formatTable));
      exitCode = status.status === "healthy" ? ExitCode.ok : ExitCode.unhealthy;
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

function formatTable(status: PlatformStatus): string {
  const rows = [["COMPONENT", "STATUS", "MESSAGE"], ...status.components.map((c) => [c.name, c.status, c.message ?? ""])];
  const widths = [0, 1].map((i) => Math.max(...rows.map((row) => row[i]!.length)));
  const lines = rows.map((row) => row.map((cell, i) => (i < 2 ? cell.padEnd(widths[i]! + 2) : cell)).join("").trimEnd());
  return `PLATFORM  ${status.status}\n\n${lines.join("\n")}\n`;
}
