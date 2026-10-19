import { checkComponents, overallState, type ComponentStatus, type HealthProbe } from "@tendworks/health";
import type { ControlPlane, Health } from "@tendworks/shared";
import createClient from "openapi-fetch";

export type PlatformStatus = ControlPlane.components["schemas"]["PlatformStatus"];
export type { ComponentStatus, HealthProbe };

/** Another runtime bundle (e.g. the worker) whose health API reports the components it owns. */
export interface RuntimeBundle {
  name: string;
  baseUrl: string;
  /** Transport; defaults to the global fetch. */
  fetch?: (request: Request) => Promise<Response>;
}

export async function checkPlatform(
  probes: HealthProbe[],
  bundles: RuntimeBundle[],
  probeTimeoutMs: number | undefined,
): Promise<PlatformStatus> {
  const [own, ...remote] = await Promise.all([
    checkComponents(probes, probeTimeoutMs),
    ...bundles.map((bundle) => checkBundle(bundle, probeTimeoutMs)),
  ]);
  const components = [...own, ...remote.flat()];
  return { status: overallState(components), components, checkedAt: new Date().toISOString() };
}

async function checkBundle(bundle: RuntimeBundle, timeoutMs = 2_000): Promise<ComponentStatus[]> {
  const client = createClient<Health.paths>({ baseUrl: bundle.baseUrl, ...(bundle.fetch ? { fetch: bundle.fetch } : {}) });
  try {
    const { data, error } = await client.GET("/health", { signal: AbortSignal.timeout(timeoutMs) });
    const report = data ?? error;
    if (!report?.components) throw new Error("unexpected health response");
    return report.components;
  } catch (error) {
    return [{ name: bundle.name, status: "unhealthy", message: error instanceof Error ? error.message : String(error) }];
  }
}
