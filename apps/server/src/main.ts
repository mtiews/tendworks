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
  createApprovals,
  createLoggingNotificationChannel,
  createMergeGate,
  createPostgresApprovalStore,
  toGatedRun,
  createPullRequestIntegrations,
  PLATFORM_GITHUB_TOKEN,
  createPostgresNotificationStore,
  createNotifier,
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

// Human interaction: run outcomes and approval requests from the event bus become
// notifications, recorded before the notification channel (a log for now) delivers them.
const notifications = createPostgresNotificationStore(pool);
const notifier = createNotifier({ store: notifications, channel: createLoggingNotificationChannel() });
const bus = createPostgresEventBus({ pool });
bus.subscribe("human-interaction.notifications", notifier.handle, { types: notifier.types });

const workerUrl = env("TEND_WORKER_URL");
const orchestration = createOrchestrationClient({ baseUrl: workerUrl });

// Human interaction: the merge gate. It decides by orchestration's record of the run and
// the policies of its workflow, never by what the caller claims; with `ask` it opens an
// approval request (approval.requested goes onto the bus with it) and merges only once
// that is approved. Merges go through the pull request integration with the platform
// token, which only this bundle holds (ADR 0008).
const approvalStore = createPostgresApprovalStore({ pool, publisher: bus });
const merges = createMergeGate({
  policies: configuration.policies,
  runs: async (runId) => {
    const run = await orchestration.get(runId);
    return run && toGatedRun(run);
  },
  pullRequests: createPullRequestIntegrations({ githubToken: () => process.env[PLATFORM_GITHUB_TOKEN] }),
  approvals: approvalStore,
});
const approvals = createApprovals({ store: approvalStore });
console.log(`configuration: policies ${configuration.policies.map((policy) => policy.metadata.name).join(", ") || "none"}`);

// The domains in this bundle talk to each other only through their APIs, in process:
// the trigger gateway starts runs through the public control plane API, and the control
// plane reads triggers through the trigger gateway's internal API.
const inProcess = (target: () => { fetch(request: Request): Promise<Response> }) => (request: Request) => target().fetch(request);

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
  runs: orchestration,
  notifications,
  merges,
  approvals,
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
