/**
 * Checks that the sandbox backend's container API is reachable. The URL points
 * at the restricted socket proxy, never at the raw Docker socket (ADR 0001).
 * Shape matches the control plane's health probe.
 */
export function createSandboxBackendProbe(url: string) {
  return {
    name: "sandbox-backend",
    async check(): Promise<{ status: "healthy" }> {
      const response = await fetch(new URL("/_ping", url), { signal: AbortSignal.timeout(1_500) });
      if (!response.ok) throw new Error(`container API answered ${response.status}`);
      return { status: "healthy" };
    },
  };
}
