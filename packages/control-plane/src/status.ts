import type { ControlPlane } from "@tendworks/shared";

export type PlatformStatus = ControlPlane.components["schemas"]["PlatformStatus"];
export type ComponentStatus = ControlPlane.components["schemas"]["ComponentStatus"];

/** A component the platform depends on, checked for every status request. */
export interface HealthProbe {
  name: string;
  check(): Promise<Omit<ComponentStatus, "name">>;
}

export async function checkPlatform(probes: HealthProbe[], timeoutMs: number): Promise<PlatformStatus> {
  const components = await Promise.all(probes.map((probe) => checkComponent(probe, timeoutMs)));
  const status = components.every((c) => c.status === "healthy") ? "healthy" : "unhealthy";
  return { status, components, checkedAt: new Date().toISOString() };
}

async function checkComponent(probe: HealthProbe, timeoutMs: number): Promise<ComponentStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return { name: probe.name, ...(await Promise.race([probe.check(), timeout])) };
  } catch (error) {
    return { name: probe.name, status: "unhealthy", message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
