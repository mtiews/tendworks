import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contractFiles, readContract } from "../contract/support/contracts.js";
import { ADAPTER_SELECTORS, findProductNames, PRODUCTS } from "./product-names.js";

// Fitness function: product names appear in no contract and no event type
// (docs/platform-architecture.md), except where configuration selects an adapter
// (ADR 0013 (contract-and-port-fitness-functions)).

describe("finding product names", () => {
  it("finds them in keys, enum and const values, titles and paths, whatever the casing", () => {
    const document = {
      paths: { "/temporal/workflows": {} },
      $defs: { githubIssue: { title: "DockerSandbox", properties: { kind: { enum: ["fake", "gVisor"] }, type: { const: "dev.tendworks.nats.message" } } } },
    };

    expect(findProductNames(document).map(({ pointer, product }) => `${pointer} ${product}`)).toEqual([
      "/paths/~1temporal~1workflows temporal",
      "/$defs/githubIssue github",
      "/$defs/githubIssue/title docker",
      "/$defs/githubIssue/properties/kind/enum/1 gvisor",
      "/$defs/githubIssue/properties/type/const nats",
    ]);
  });

  it("ignores prose and words that only contain a product name", () => {
    const document = {
      description: "Runs on Temporal, e.g. with Docker.",
      properties: { opaque: { type: "string", examples: ["claude"], pattern: "^github" }, temporality: { summary: "NATS" } },
    };

    expect(findProductNames(document)).toEqual([]);
  });
});

describe("contracts", () => {
  const found = contractFiles().flatMap((file) => findProductNames(readContract(file)).map((hit) => ({ file, ...hit })));
  const allowed = (hit: (typeof found)[number]) =>
    ADAPTER_SELECTORS.some(
      (selector) => selector.file === hit.file && selector.product === hit.product && (hit.pointer === selector.under || hit.pointer.startsWith(`${selector.under}/`)),
    );

  it("name no product outside the configuration that selects an adapter", () => {
    expect(found.filter((hit) => !allowed(hit)).map(({ file, pointer, product }) => `${file}#${pointer}: ${product}`)).toEqual([]);
  });

  it("allow no adapter selector that no contract needs any more", () => {
    const unused = ADAPTER_SELECTORS.filter((selector) => !found.some((hit) => allowed(hit) && hit.file === selector.file && hit.pointer.startsWith(selector.under)));

    expect(unused).toEqual([]);
  });

  it("list every adapter selector's product as a product", () => {
    expect(ADAPTER_SELECTORS.filter((selector) => !PRODUCTS.includes(selector.product))).toEqual([]);
  });

  it("never let an event schema name a product: events select no adapter", () => {
    expect(ADAPTER_SELECTORS.filter((selector) => selector.file.startsWith("events/"))).toEqual([]);
  });
});

describe("trigger sources", () => {
  // Products a trigger kind selects (e.g. `github-issues`): only their source packages
  // (packages/trigger-source-*) may name them, never the trigger gateway.
  const products = [...new Set(ADAPTER_SELECTORS.filter((selector) => selector.file === "schemas/trigger-binding.schema.yaml").map((selector) => selector.product))];
  const gateway = fileURLToPath(new URL("../../packages/trigger-gateway/src/", import.meta.url));
  const code = readdirSync(gateway, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !/\.(test|suite)\.ts$/.test(file))
    .map((file) => ({ file: file.split("\\").join("/"), text: readFileSync(join(gateway, file), "utf8").toLowerCase() }));

  it("are named only by the trigger kind selector of the binding schema", () => {
    expect(products).toEqual(["github"]);
  });

  it("are never named by the trigger gateway's code, which knows sources only through the port", () => {
    expect(code.length).toBeGreaterThan(0);
    expect(code.flatMap(({ file, text }) => products.filter((product) => text.includes(product)).map((product) => `${file}: ${product}`))).toEqual([]);
  });
});
