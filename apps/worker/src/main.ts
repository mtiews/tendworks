import { serve } from "@hono/node-server";
import { createHealthApi } from "@tendworks/health";
import { createExecutionEngineProbe } from "@tendworks/orchestration";
import { createSandboxBackendProbe } from "@tendworks/sandbox";

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`missing environment variable ${name}`);
  return value;
};

// Internal health API (contracts/openapi/health.yaml) for the control plane; never published.
const health = createHealthApi({
  probes: [
    createExecutionEngineProbe(env("TEND_EXECUTION_ENGINE_ADDRESS")),
    createSandboxBackendProbe(env("TEND_SANDBOX_BACKEND_URL")),
  ],
});

const port = Number(env("PORT", "8081"));
const server = serve({ fetch: health.fetch, port }, () => console.log(`worker health API listening on :${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
