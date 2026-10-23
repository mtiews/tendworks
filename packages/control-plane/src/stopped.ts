import type { ControlPlane } from "@tendworks/shared";
import { checkPlatform, type HealthProbe, type RuntimeBundle } from "./status.js";

type Schemas = ControlPlane.components["schemas"];

export interface StoppedControlPlaneApiOptions {
  /** The control plane's components, including the one that stopped it (e.g. a failed schema migration). */
  probes: HealthProbe[];
  bundles?: RuntimeBundle[];
  probeTimeoutMs?: number;
  /** Why the server stopped; every operation but `GET /status` answers 503 with it. */
  reason: string;
}

/**
 * The control plane of a server that must not work, e.g. because a schema migration failed:
 * it keeps answering `GET /status`, so the operator sees why, and refuses every other
 * operation, so nothing runs on a half-migrated store.
 */
export function createStoppedControlPlaneApi({ probes, bundles = [], probeTimeoutMs, reason }: StoppedControlPlaneApiOptions): {
  fetch(request: Request): Promise<Response>;
} {
  return {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/status" && (request.method === "GET" || request.method === "HEAD")) {
        const report = await checkPlatform(probes, bundles, probeTimeoutMs);
        return Response.json(report, { status: report.status === "healthy" ? 200 : 503 });
      }
      return Response.json({ title: "Platform stopped", status: 503, detail: reason } satisfies Schemas["Problem"], { status: 503 });
    },
  };
}
