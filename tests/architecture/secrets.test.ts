import { readFileSync } from "node:fs";
import { createSecretResolver } from "@tendworks/platform";
import { expect, it } from "vitest";
import { parse } from "yaml";

// Which bundle may hold which repository token (deploy/compose.yaml). Sandboxes are
// started by the worker, so a secret the worker does not have can never reach one.

type Service = {
  environment?: Record<string, unknown>;
  env_file?: (string | { path: string; required?: boolean })[];
  networks?: string[];
  network_mode?: string;
  command?: string[];
  volumes?: string[];
  depends_on?: Record<string, { condition: string }>;
};
const read = (path: string) => readFileSync(new URL(`../../deploy/${path}`, import.meta.url), "utf8");
const compose = parse(read("compose.yaml")) as {
  services: Record<string, Service>;
  networks?: Record<string, { name?: string }>;
};
const environment = (service: string) => Object.keys(compose.services[service]?.environment ?? {});
/** The services compose hands deploy/.env as a whole. */
const withEnvFile = Object.entries(compose.services)
  .filter(([, service]) => service.env_file?.some((file) => (typeof file === "string" ? file : file.path) === ".env"))
  .map(([name]) => name);
/** Every variable an operator may set in deploy/.env (deploy/.env.example). */
const operatorVariables = Object.fromEntries([...read(".env.example").matchAll(/^#? ?([A-Z][A-Z0-9_]*)=/gm)].map((match) => [match[1], "value"]));

it("never gives the platform's repository token to the worker, which starts the sandboxes", () => {
  expect(environment("worker")).not.toContain("TENDWORKS_PLATFORM_GITHUB_TOKEN");
});

it("hands deploy/.env as a whole only to the agent secrets exporter, which reaches no network", () => {
  // Every TENDWORKS_AGENT_* line in deploy/.env reaches the worker without a compose edit,
  // through a file the exporter writes with agent secrets only (ADR 0008).
  expect(withEnvFile).toEqual(["agent-secrets"]);
  const exporter = compose.services["agent-secrets"]!;
  expect(exporter.network_mode).toBe("none");
  expect(exporter.networks).toBeUndefined();
  expect(exporter.command).toEqual(["node", "apps/worker/dist/export-agent-secrets.js"]);
  expect(exporter.environment?.TEND_AGENT_SECRETS_FILE).toBe(compose.services.worker?.environment?.TEND_AGENT_SECRETS_FILE);
});

it("gives agent secrets only to the worker, which reads them from the exporter's file", () => {
  expect(compose.services.worker?.volumes).toContain("agent-secrets:/var/lib/tendworks/agent-secrets:ro");
  expect(compose.services.worker?.environment?.TEND_AGENT_SECRETS_FILE).toBe("/var/lib/tendworks/agent-secrets/agent-secrets.json");
  expect(compose.services.worker?.depends_on?.["agent-secrets"]).toEqual({ condition: "service_completed_successfully" });
  expect(compose.services.server?.volumes?.filter((volume) => volume.startsWith("agent-secrets:"))).toEqual([]);
  expect(environment("server").filter((name) => name.startsWith("TENDWORKS_AGENT_"))).toEqual([]);
});

it("lets agent profiles reference only the agent secrets of deploy/.env", () => {
  const agentSecrets = createSecretResolver("agent", operatorVariables);

  expect(Object.keys(operatorVariables).filter((name) => agentSecrets.resolve(name) !== undefined)).toEqual(["TENDWORKS_AGENT_GITHUB_TOKEN"]);
});

it("never lets an agent profile hand the worker's API token into a sandbox", () => {
  // The worker holds the token for the merge step; a sandbox only gets the harness
  // credential and what agent profiles reference, which resolves to agent secrets only.
  expect(environment("worker")).toContain("TEND_API_TOKEN");
  const worker = Object.fromEntries(environment("worker").map((name) => [name, "value"]));
  const agentSecrets = createSecretResolver("agent", worker);

  expect(environment("worker").filter((name) => agentSecrets.resolve(name) !== undefined)).toEqual([]);
});

it("never lets an agent profile hand the read-only token into a sandbox", () => {
  // The server checks it; only the platform MCP server's sessions may get it, passed by the
  // agent runtime itself (ADR 0016), never through a profile's secret references.
  expect(environment("server")).toContain("TEND_API_READ_TOKEN");
  const everything = Object.fromEntries([...environment("server"), ...environment("worker")].map((name) => [name, "value"]));

  expect(createSecretResolver("agent", everything).resolve("TEND_API_READ_TOKEN")).toBeUndefined();
  expect(createSecretResolver("agent", everything).resolve("TEND_API_TOKEN")).toBeUndefined();
});

it("starts sandboxes on a network of their own, not on one of the stack's", () => {
  // The sandbox adapter names it <installation>-sandboxes, the installation being the
  // project name; compose names the stack's networks <project>_<network> unless they
  // carry a name of their own.
  const project = "tendworks";
  const network = `${project}-sandboxes`;
  const stack = ["default", ...Object.keys(compose.networks ?? {})].map((name) => `${project}_${name}`);
  const named = Object.values(compose.networks ?? {}).flatMap(({ name }) => (name ? [name.replaceAll("${COMPOSE_PROJECT_NAME}", project)] : []));

  expect(compose.services.worker?.environment?.TEND_INSTALLATION).toBe("${COMPOSE_PROJECT_NAME}");
  expect([...stack, ...named]).not.toContain(network);
});
