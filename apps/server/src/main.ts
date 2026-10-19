import { serve } from "@hono/node-server";
import {
  ConfigurationError,
  createControlPlaneApi,
  createOrchestrationClient,
  createStoreProbe,
  createTriggerGatewayClient,
  loadConfiguration,
  type Configuration,
} from "@tendworks/control-plane";
import { createPostgresEventBus, migrateEventBus } from "@tendworks/event-bus";
import {
  createLoggingNotificationChannel,
  createPostgresNotificationStore,
  createRunOutcomeNotifier,
  migrateHumanInteractionStore,
} from "@tendworks/human-interaction";
import {
  createControlPlaneRunStarter,
  createPostgresFiringStore,
  createTriggerGateway,
  createTriggerGatewayApi,
  migrateTriggerGatewayStore,
} from "@tendworks/trigger-gateway";
import pg from "pg";

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
console.log(`configuration: trigger bindings ${configuration.triggerBindings.map((binding) => binding.metadata.name).join(", ") || "none"}`);

const databaseUrl = env("TEND_DATABASE_URL");
const pool = new pg.Pool({ connectionString: databaseUrl });
await migrateEventBus(pool);
await migrateHumanInteractionStore(pool);
await migrateTriggerGatewayStore(pool);

// Human interaction: run outcomes from the event bus become notifications, recorded
// before the notification channel (a log for now) delivers them.
const notifications = createPostgresNotificationStore(pool);
const notifier = createRunOutcomeNotifier({ store: notifications, channel: createLoggingNotificationChannel() });
const bus = createPostgresEventBus({ pool });
bus.subscribe("human-interaction.run-outcomes", notifier.handle, { types: notifier.types });

// The domains in this bundle talk to each other only through their APIs, in process:
// the trigger gateway starts runs through the public control plane API, and the control
// plane reads triggers through the trigger gateway's internal API.
const inProcess = (target: () => { fetch(request: Request): Promise<Response> }) => (request: Request) => target().fetch(request);

const workerUrl = env("TEND_WORKER_URL");
const triggerGateway = createTriggerGateway({
  bindings: configuration.triggerBindings,
  // trigger.fired goes onto the event bus in the transaction that records the firing.
  store: createPostgresFiringStore({ pool, publisher: bus }),
  runs: createControlPlaneRunStarter({ baseUrl: "http://control-plane.internal", fetch: inProcess(() => api) }),
});
const triggerGatewayApi = createTriggerGatewayApi(triggerGateway);
const api = createControlPlaneApi({
  probes: [createStoreProbe(databaseUrl)],
  bundles: [{ name: "worker", baseUrl: workerUrl }],
  configuration,
  runs: createOrchestrationClient({ baseUrl: workerUrl }),
  notifications,
  triggers: createTriggerGatewayClient({ baseUrl: "http://trigger-gateway.internal", fetch: inProcess(() => triggerGatewayApi) }),
});

const port = Number(env("PORT", "8080"));
const server = serve({ fetch: api.fetch, port }, () => console.log(`control plane listening on :${port}`));
triggerGateway.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await triggerGateway.stop();
    server.close(async () => {
      await bus.close();
      await pool.end();
      process.exit(0);
    });
  });
}
