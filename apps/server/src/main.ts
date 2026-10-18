import { serve } from "@hono/node-server";
import { createControlPlaneApi, createStoreProbe } from "@tendworks/control-plane";
import { createExecutionEngineProbe } from "@tendworks/orchestration";
import { createSandboxBackendProbe } from "@tendworks/sandbox";

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`missing environment variable ${name}`);
  return value;
};

const api = createControlPlaneApi({
  probes: [
    createStoreProbe(env("TEND_DATABASE_URL")),
    createExecutionEngineProbe(env("TEND_EXECUTION_ENGINE_ADDRESS")),
    createSandboxBackendProbe(env("TEND_SANDBOX_BACKEND_URL")),
  ],
});

const port = Number(env("PORT", "8080"));
const server = serve({ fetch: api.fetch, port }, () => console.log(`control plane listening on :${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
