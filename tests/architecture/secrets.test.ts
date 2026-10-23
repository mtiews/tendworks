import { readFileSync } from "node:fs";
import { createSecretResolver } from "@tendworks/platform";
import { expect, it } from "vitest";
import { parse } from "yaml";

// Which bundle may hold which repository token (deploy/compose.yaml). Sandboxes are
// started by the worker, so a secret the worker does not have can never reach one.

const compose = parse(readFileSync(new URL("../../deploy/compose.yaml", import.meta.url), "utf8")) as {
  services: Record<string, { environment?: Record<string, unknown>; networks?: string[] }>;
  networks?: Record<string, { name?: string }>;
};
const environment = (service: string) => Object.keys(compose.services[service]?.environment ?? {});

it("never gives the platform's repository token to the worker, which starts the sandboxes", () => {
  expect(environment("worker")).not.toContain("TENDWORKS_PLATFORM_GITHUB_TOKEN");
});

it("gives the agent's repository token only to the worker", () => {
  expect(environment("worker")).toContain("TENDWORKS_AGENT_GITHUB_TOKEN");
  expect(environment("server")).not.toContain("TENDWORKS_AGENT_GITHUB_TOKEN");
});

it("never lets an agent profile hand the worker's API token into a sandbox", () => {
  // The worker holds the token for the merge step; a sandbox only gets the harness
  // credential and what agent profiles reference, which resolves to agent secrets only.
  expect(environment("worker")).toContain("TEND_API_TOKEN");
  const worker = Object.fromEntries(environment("worker").map((name) => [name, "value"]));
  const agentSecrets = createSecretResolver("agent", worker);

  expect(environment("worker").filter((name) => agentSecrets.resolve(name) !== undefined)).toEqual(["TENDWORKS_AGENT_GITHUB_TOKEN"]);
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
