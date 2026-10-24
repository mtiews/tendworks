import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  apiTokenProblems,
  ConfigurationError,
  createAgentRuntimeClient,
  createControlPlaneApi,
  createOrchestrationClient,
  createStoppedControlPlaneApi,
  createStoreProbe,
  createTriggerGatewayClient,
  loadConfiguration,
  type Configuration,
} from "@tendworks/control-plane";
import { createPostgresEventBus, migrateEventBus } from "@tendworks/event-bus";
import {
  createApprovals,
  createLoggingNotificationChannel,
  createPostgresApprovalStore,
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
import { createPlatformMcpServer } from "@tendworks/mcp-platform";
import { createSecretResolver } from "@tendworks/platform";
import { migrateOrStop } from "@tendworks/platform/migrations";
import { storeConnectionString } from "@tendworks/platform/store-connection";
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

// Secret references of the platform's integrations (trigger bindings): only
// TENDWORKS_PLATFORM_* variables resolve (ADR 0008). Never log values.
const platformSecrets = createSecretResolver("platform", process.env);

// Every operation but GET /status needs a token: the API token for anything, the
// read-only token for reading only (ADR 0014 (interim-bearer-token-on-the-control-plane-api),
// ADR 0016 (chat-agents-read-the-platform-through-mcp-with-a-read-only-token)). Both must be
// set; there are no defaults, and compose passes an unset variable as an empty string.
const apiToken = process.env.TEND_API_TOKEN || undefined;
const readToken = process.env.TEND_API_READ_TOKEN || undefined;
const tokenProblems = apiTokenProblems({ ...(apiToken === undefined ? {} : { apiToken }), ...(readToken === undefined ? {} : { readToken }) });
if (apiToken === undefined || readToken === undefined || tokenProblems.length > 0) {
  for (const problem of tokenProblems) console.error(problem);
  process.exit(1);
}

// The store's password has no default (scripts/setup-env.sh generates it); never log it.
let databaseUrl: string;
try {
  databaseUrl = storeConnectionString(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: databaseUrl });
// Each domain brings its own tables to the version this release needs (docs/platform-implementation.md,
// "Schema migrations"). A failed migration was rolled back; the server then stops working
// and only answers GET /status, which names it, so it never runs on a half-migrated store (ADR 0021).
await migrateOrStop(
  pool,
  [
    ["event bus", migrateEventBus],
    ["human interaction", migrateHumanInteractionStore],
    ["trigger gateway", migrateTriggerGatewayStore],
  ],
  {
    bundle: "server",
    answers: "GET /status",
    stop: (error) => {
      const stopped = createStoppedControlPlaneApi({
        probes: [createStoreProbe(databaseUrl), { name: error.component, check: async () => ({ status: "unhealthy", message: error.message }) }],
        bundles: [{ name: "worker", baseUrl: env("TEND_WORKER_URL") }],
      });
      serve({ fetch: (request) => stopped.fetch(request), port: Number(env("PORT", "8080")) });
    },
  },
);

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

// Human interaction: approval requests; approval.requested and approval.decided go onto
// the bus with each write.
const approvalStore = createPostgresApprovalStore({ pool, publisher: bus });
const approvals = createApprovals({ store: approvalStore });

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
// The web UI's static build (ADR 0018): `pnpm build` puts it next to this bundle, in the image too.
const webUiRoot = process.env.TEND_WEB_UI_DIR || fileURLToPath(new URL("../../web/dist/", import.meta.url));
const api = createControlPlaneApi({
  probes: [createStoreProbe(databaseUrl)],
  bundles: [{ name: "worker", baseUrl: workerUrl }],
  configuration,
  runs: orchestration,
  agentRuntime,
  notifications,
  approvals,
  triggers: createTriggerGatewayClient({ baseUrl: "http://trigger-gateway.internal", fetch: inProcess(() => triggerGatewayApi) }),
  apiToken,
  readToken,
  ...(existsSync(webUiRoot) ? { webUi: { root: webUiRoot } } : {}),
});
console.log(existsSync(webUiRoot) ? `web UI: ${webUiRoot} under /ui/` : `web UI: no build at ${webUiRoot}; /ui/ answers 404`);

// The platform MCP server (ADR 0016) at /mcp, for chat agents: a client of the public API
// above with the token its caller presents, so it can read no more than that token may.
const mcp = createPlatformMcpServer({ controlPlane: { baseUrl: "http://control-plane.internal", fetch: inProcess(() => api) } });
const MCP_PATH = "/mcp";

const port = Number(env("PORT", "8080"));
const server = serve({ fetch: (request) => (new URL(request.url).pathname === MCP_PATH ? mcp.fetch(request) : api.fetch(request)), port }, () => console.log(`control plane listening on :${port}`));
triggerGateway.start();

async function shutdown() {
  await triggerGateway.stop();
  const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  // Followed transcripts keep connections open; their clients reconnect with Last-Event-ID.
  if ("closeAllConnections" in server) server.closeAllConnections();
  await closed;
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
