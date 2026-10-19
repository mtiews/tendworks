import type { A2A, AgentProfile } from "@tendworks/shared";

export type ReportedArtifact = AgentProfile.ReportedArtifact;

/** A result an agent reported as a link, as an A2A artifact of its task. */
export function toArtifact(taskId: string, { name, url, description }: ReportedArtifact): A2A.Artifact {
  return { artifactId: `${taskId}/${name}`, name, ...(description === undefined ? {} : { description }), parts: [{ url }] };
}

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Reads what an agent reported in its artifacts file: a JSON array of `{ name, url,
 * description? }` (contracts/schemas/agent-profile.schema.yaml#/$defs/reportedArtifact).
 */
export function parseReportedArtifacts(text: string): { artifacts: ReportedArtifact[] } | { problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { problem: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!Array.isArray(value)) return { problem: "not a JSON array" };
  const artifacts: ReportedArtifact[] = [];
  for (const [index, item] of value.entries()) {
    const { name, url, description } = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof name !== "string" || !NAME.test(name) || typeof url !== "string" || !URL.canParse(url) || (description !== undefined && typeof description !== "string")) {
      return { problem: `item ${index} is not { name, url, description? } with a lowercase name and an absolute URL` };
    }
    artifacts.push({ name, url, ...(description === undefined ? {} : { description }) });
  }
  return { artifacts };
}
