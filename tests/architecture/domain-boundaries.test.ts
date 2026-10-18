import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { cruise, type IViolation } from "dependency-cruiser";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { forbidden } = require("../../.dependency-cruiser.cjs");

// A tiny repository with two domains, shared types and the health library.
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

it("allows a domain to use generated types and the health library", async () => {
  expect(await violationsIn("packages/alpha/src/allowed.ts")).toEqual([]);
});
