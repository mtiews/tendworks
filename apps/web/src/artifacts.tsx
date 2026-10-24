import type { ControlPlane } from "@tendworks/shared";
import { safeHref } from "./markdown.js";

type Artifact = ControlPlane.components["schemas"]["stepArtifact"];

/** Links an agent reported as results, e.g. the pull request it opened; a link that is not http(s) stays text. */
export function Artifacts({ artifacts }: { artifacts: readonly Artifact[] }) {
  if (artifacts.length === 0) return null;
  return (
    <ul className="artifacts">
      {artifacts.map((artifact) => {
        const href = safeHref(artifact.url);
        return (
          <li key={`${artifact.name} ${artifact.url}`}>
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {artifact.name}
              </a>
            ) : (
              artifact.name
            )}
            {artifact.description && <span className="muted"> {artifact.description}</span>}
          </li>
        );
      })}
    </ul>
  );
}
