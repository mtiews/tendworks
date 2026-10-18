import { serve } from "@hono/node-server";
import {
  ConfigurationError,
  createControlPlaneApi,
  createOrchestrationClient,
  createStoreProbe,
  loadConfiguration,
  type Configuration,
} from "@tendworks/control-plane";

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`missing environment variable ${name}`);
  return value;
};

let configuration: Configuration;
try {
  configuration = loadConfiguration(env("TEND_CONFIG_DIR"));
} catch (error) {
  // Invalid configuration stops the platform before it accepts any request.
  if (!(error instanceof ConfigurationError)) throw error;
  console.error(error.message);
  process.exit(1);
}
console.log(`configuration: workflows ${configuration.workflowNames.join(", ") || "none"}`);

const workerUrl = env("TEND_WORKER_URL");
const api = createControlPlaneApi({
  probes: [createStoreProbe(env("TEND_DATABASE_URL"))],
  bundles: [{ name: "worker", baseUrl: workerUrl }],
  configuration,
  runs: createOrchestrationClient({ baseUrl: workerUrl }),
});

const port = Number(env("PORT", "8080"));
const server = serve({ fetch: api.fetch, port }, () => console.log(`control plane listening on :${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
