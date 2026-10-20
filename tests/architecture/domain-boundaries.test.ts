import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { cruise, type IViolation } from "dependency-cruiser";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { forbidden } = require("../../.dependency-cruiser.cjs");

// A tiny repository with two domains, shared types and the platform libraries.
const fixture = fileURLToPath(new URL("./fixtures", import.meta.url));

async function violationsIn(path: string): Promise<IViolation[]> {
  const result = await cruise([path], { baseDir: fixture, ruleSet: { forbidden }, validate: true });
  if (typeof result.output === "string") throw new Error("unexpected string output");
  return result.output.summary.violations;
}

it("rejects a domain importing another domain", async () => {
  const violations = await violationsIn("packages/alpha/src/violation.ts");

  expect(violations.map((v) => [v.rule.name, v.to])).toEqual([["no-cross-domain-imports", "packages/beta/src/index.ts"]]);
});

it("allows a domain to use generated types and the platform libraries", async () => {
  expect(await violationsIn("packages/alpha/src/allowed.ts")).toEqual([]);
});

it("rejects a platform library that knows a domain", async () => {
  const violations = await violationsIn("packages/platform/src/violation.ts");

  expect(violations.map((v) => [v.rule.name, v.to])).toEqual([["platform-libraries-are-leaves", "packages/beta/src/index.ts"]]);
});

it("allows the web app only generated types and the platform library", async () => {
  expect(await violationsIn("apps/web/src/index.tsx")).toEqual([]);
});

it("rejects the web app importing a domain, the health library, another app or a Node.js module", async () => {
  const violations = await violationsIn("apps/web/src/violation.ts");

  expect(violations.map((v) => [v.rule.name, v.to]).sort()).toEqual([
    ["apps-do-not-import-each-other", "apps/cli/src/index.ts"],
    ["web-app-is-a-client", "apps/cli/src/index.ts"],
    ["web-app-is-a-client", "fs"],
    ["web-app-is-a-client", "packages/beta/src/index.ts"],
    ["web-app-is-a-client", "packages/health/src/index.ts"],
  ]);
});

it("lets the view tests render the web app over the domains, and nothing else under tests/ import an app", async () => {
  const views = await violationsIn("tests/web/sign-in.tsx");
  const otherApp = await violationsIn("tests/web/violation.ts");
  const contract = await violationsIn("tests/contract/violation.ts");

  expect(views).toEqual([]);
  expect(otherApp.map((v) => [v.rule.name, v.to])).toEqual([["nothing-imports-apps", "apps/cli/src/index.ts"]]);
  expect(contract.map((v) => [v.rule.name, v.to])).toEqual([["nothing-imports-apps", "apps/web/src/index.tsx"]]);
});
