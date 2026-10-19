import { serve } from "@hono/node-server";
import {
  ConfigurationError,
  createControlPlaneApi,
  createOrchestrationClient,
  createStoreProbe,
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

const databaseUrl = env("TEND_DATABASE_URL");
const pool = new pg.Pool({ connectionString: databaseUrl });
await migrateEventBus(pool);
await migrateHumanInteractionStore(pool);

// Human interaction: run outcomes from the event bus become notifications, recorded
// before the notification channel (a log for now) delivers them.
const notifications = createPostgresNotificationStore(pool);
const notifier = createRunOutcomeNotifier({ store: notifications, channel: createLoggingNotificationChannel() });
const bus = createPostgresEventBus({ pool });
bus.subscribe("human-interaction.run-outcomes", notifier.handle, { types: notifier.types });

const workerUrl = env("TEND_WORKER_URL");
const api = createControlPlaneApi({
  probes: [createStoreProbe(databaseUrl)],
  bundles: [{ name: "worker", baseUrl: workerUrl }],
  configuration,
  runs: createOrchestrationClient({ baseUrl: workerUrl }),
  notifications,
});

const port = Number(env("PORT", "8080"));
const server = serve({ fetch: api.fetch, port }, () => console.log(`control plane listening on :${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () =>
    server.close(async () => {
      await bus.close();
      await pool.end();
      process.exit(0);
    }),
  );
}
