import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { PORTS } from "./ports.js";

// Fitness function: every port has at least two implementations; the second may be a
// fake used in tests (docs/platform-architecture.md). Ports are declared, not guessed:
// every port interface carries `@port` in its doc comment, and ports.ts names its
// implementations, which the type checker holds to the interface.

const packages = new URL("../../packages/", import.meta.url);

/** `<package>/<interface>` of every interface tagged `@port` in the packages' sources. */
function taggedPorts(): string[] {
  const ports: string[] = [];
  for (const file of readdirSync(packages, { recursive: true, encoding: "utf8" })) {
    const path = file.replaceAll("\\", "/");
    if (!/^[^/]+\/src\/.*\.ts$/.test(path) || /\.(test|suite|stub)\.ts$/.test(path)) continue;
    const source = readFileSync(new URL(path, packages), "utf8");
    for (const match of source.matchAll(/\/\*\*(?:(?!\*\/)[\s\S])*@port\b(?:(?!\*\/)[\s\S])*\*\/\s*export interface (\w+)/g)) {
      ports.push(`${path.split("/")[0]}/${match[1]}`);
    }
  }
  return ports.sort();
}

it("declares the implementations of exactly the interfaces tagged as ports", () => {
  const tagged = taggedPorts();

  expect(tagged.length).toBeGreaterThan(0);
  expect(Object.keys(PORTS).sort()).toEqual(tagged);
});

it("gives every port at least two implementations", () => {
  const short = Object.entries(PORTS)
    .filter(([, implementations]) => Object.values(implementations).filter((implementation) => typeof implementation === "function").length < 2)
    .map(([port]) => port);

  expect(short).toEqual([]);
});
