import { serve } from "@hono/node-server";
import {
  apiTokenProblems,
  ConfigurationError,
  createAgentRuntimeClient,
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
import { createSecretResolver } from "@tendworks/platform";
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

// Secret references of the platform's integrations (trigger bindings, merging pull
// requests): only TENDWORKS_PLATFORM_* variables resolve (ADR 0008). Never log values.
const platformSecrets = createSecretResolver("platform", process.env);

// Every operation but GET /status needs a token: the API token for anything, the
// optional read-only token for reading only (ADR 0014 (interim-bearer-token-on-the-control-plane-api),
// ADR 0016 (chat-agents-read-the-platform-through-mcp-with-a-read-only-token)).
const apiToken = env("TEND_API_TOKEN");
const readToken = process.env.TEND_API_READ_TOKEN || undefined;
const tokenProblems = apiTokenProblems({ apiToken, ...(readToken === undefined ? {} : { readToken }) });
if (tokenProblems.length > 0) {
  for (const problem of tokenProblems) console.error(problem);
  process.exit(1);
}

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
bus.subscribe("human-interaction.notifications", notifier.handle.bind(notifier), { types: notifier.types });

const workerUrl = env("TEND_WORKER_URL");
const orchestration = createOrchestrationClient({ baseUrl: workerUrl });
// The agent runtime runs in the worker too; transcripts are read through its internal API.
const agentRuntime = createAgentRuntimeClient({ baseUrl: workerUrl });

// Human interaction: the merge gate. It decides by orchestration's record of the run and
// the policies of its workflow, never by what the caller claims; with `ask` it opens an
// approval request (approval.requested goes onto the bus with it) and merges only once
// that is approved. Merges go through the pull request integration configured for the
// pull request's host, with the platform token only this bundle holds (ADR 0008).
const approvalStore = createPostgresApprovalStore({ pool, publisher: bus });
const merges = createMergeGate({
  policies: configuration.policies,
  runs: async (runId) => {
    const run = await orchestration.get(runId);
    return run && toGatedRun(run);
  },
  pullRequests: createPullRequestIntegrations({ integrations: configuration.pullRequestIntegrations, secrets: platformSecrets }),
  approvals: approvalStore,
});
const approvals = createApprovals({ store: approvalStore });
console.log(`configuration: policies ${configuration.policies.map((policy) => policy.metadata.name).join(", ") || "none"}`);
console.log(
  `configuration: pull request integrations ${configuration.pullRequestIntegrations.map(({ metadata, spec }) => `${metadata.name} (${spec.integration} on ${spec.host})`).join(", ") || "none"}`,
);

// The domains in this bundle talk to each other only through their APIs, in process:
// the trigger gateway starts runs through the public control plane API, and the control
// plane reads triggers through the trigger gateway's internal API.
const inProcess = (target: () => { fetch(request: Request): Promise<Response> }) => (request: Request) => target().fetch(request);

const triggerGateway = createTriggerGateway({
  bindings: configuration.triggerBindings,
  // trigger.fired goes onto the event bus in the transaction that records the firing.
  store: createPostgresFiringStore({ pool, publisher: bus }),
  secrets: platformSecrets,
  runs: createControlPlaneRunStarter({ baseUrl: "http://control-plane.internal", apiToken, fetch: inProcess(() => api) }),
});
const triggerGatewayApi = createTriggerGatewayApi(triggerGateway);
const api = createControlPlaneApi({
  probes: [createStoreProbe(databaseUrl)],
  bundles: [{ name: "worker", baseUrl: workerUrl }],
  configuration,
  runs: orchestration,
  agentRuntime,
  notifications,
  merges,
  approvals,
  triggers: createTriggerGatewayClient({ baseUrl: "http://trigger-gateway.internal", fetch: inProcess(() => triggerGatewayApi) }),
  apiToken,
  ...(readToken === undefined ? {} : { readToken }),
});

const port = Number(env("PORT", "8080"));
const server = serve({ fetch: (request) => api.fetch(request), port }, () => console.log(`control plane listening on :${port}`));
triggerGateway.start();

async function shutdown() {
  await triggerGateway.stop();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await bus.close();
  await pool.end();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("shutdown failed:", error);
        process.exit(1);
      },
    );
  });
}
