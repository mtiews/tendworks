/*
 * The one list of product names that must not appear in contracts or event types, and
 * the few places where configuration may name one because it selects that adapter
 * (ADR 0013 (contract-and-port-fitness-functions)).
 */

/** Products the platform runs on or integrates, lower case. Add a product when an adapter for it arrives. */
export const PRODUCTS: readonly string[] = [
  "anthropic",
  "claude",
  "codex",
  "docker",
  "firecracker",
  "forgejo",
  "garage",
  "gemini",
  "github",
  "gitlab",
  "gvisor",
  "kafka",
  "kata",
  "keycloak",
  "kubernetes",
  "litellm",
  "minio",
  "nats",
  "nginx",
  "ntfy",
  "openai",
  "opa",
  "opensandbox",
  "postgres",
  "postgresql",
  "redis",
  "sops",
  "temporal",
];

export interface AdapterSelector {
  /** Contract document, as a path under contracts/. */
  file: string;
  /** JSON pointer of the part of the document that may name the product. */
  under: string;
  product: string;
  /** Why this configuration names a product. */
  reason: string;
}

/**
 * Where a contract may name a product: an enum value (and the settings block keyed by
 * it) with which an operator selects an adapter in configuration. Nothing else: no
 * path, operation, event type or field of an API names a product.
 */
export const ADAPTER_SELECTORS: readonly AdapterSelector[] = [
  {
    file: "schemas/agent-profile.schema.yaml",
    under: "/properties/spec",
    product: "claude",
    reason: "`harness: claude-code` selects the harness adapter that runs an agent profile",
  },
  {
    file: "schemas/trigger-binding.schema.yaml",
    under: "/$defs/issueSource",
    product: "github",
    reason: "`integration: github` selects the issue tracker adapter, configured under `github`",
  },
  {
    file: "schemas/trigger-binding.schema.yaml",
    under: "/$defs/githubIssueTracker",
    product: "github",
    reason: "settings of the `github` issue tracker adapter",
  },
  {
    file: "schemas/sandbox-template.schema.json",
    under: "/properties/spec/properties/isolationClass",
    product: "gvisor",
    reason: "`isolationClass: gvisor` selects the isolation runtime of a sandbox template (ADR 0001)",
  },
  {
    file: "openapi/sandbox.yaml",
    under: "/components/schemas/IsolationClass",
    product: "gvisor",
    reason: "the isolation class of a sandbox, as its sandbox template selected it (ADR 0001)",
  },
];

/** Keys whose values are prose or references, not names the contract defines. */
const PROSE = new Set(["description", "summary", "examples", "example", "$comment", "$id", "$schema", "$ref", "pattern"]);

const segment = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

/** Words of a name: each alphanumeric run as a whole and split at camel case, lower case. */
function words(name: string): Set<string> {
  const result = new Set<string>();
  for (const run of name.match(/[A-Za-z0-9]+/g) ?? []) {
    result.add(run.toLowerCase());
    for (const part of run.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? []) result.add(part.toLowerCase());
  }
  return result;
}

function productsIn(name: string): string[] {
  const found = words(name);
  return PRODUCTS.filter((product) => found.has(product));
}

/**
 * Product names a document defines: in keys (properties, definitions, paths), and in
 * string values such as enum and const values, titles and operation ids. Prose
 * (descriptions, examples) and references are not names and are skipped.
 */
export function findProductNames(document: unknown): { pointer: string; product: string }[] {
  const hits: { pointer: string; product: string }[] = [];
  const visit = (node: unknown, pointer: string) => {
    if (typeof node === "string") {
      for (const product of productsIn(node)) hits.push({ pointer, product });
    } else if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${pointer}/${index}`));
    } else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        const at = `${pointer}/${segment(key)}`;
        for (const product of productsIn(key)) hits.push({ pointer: at, product });
        if (!PROSE.has(key)) visit(value, at);
      }
    }
  };
  visit(document, "");
  return hits;
}
