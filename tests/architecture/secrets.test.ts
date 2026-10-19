import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

// Which bundle may hold which repository token (deploy/compose.yaml). Sandboxes are
// started by the worker, so a secret the worker does not have can never reach one.

const compose = parse(readFileSync(new URL("../../deploy/compose.yaml", import.meta.url), "utf8")) as {
  services: Record<string, { environment?: Record<string, unknown> }>;
};
const environment = (service: string) => Object.keys(compose.services[service]?.environment ?? {});

it("never gives the platform's repository token to the worker, which starts the sandboxes", () => {
  expect(environment("worker")).not.toContain("TENDWORKS_PLATFORM_GITHUB_TOKEN");
});

it("gives the agent's repository token only to the worker", () => {
  expect(environment("worker")).toContain("TENDWORKS_AGENT_GITHUB_TOKEN");
  expect(environment("server")).not.toContain("TENDWORKS_AGENT_GITHUB_TOKEN");
});
