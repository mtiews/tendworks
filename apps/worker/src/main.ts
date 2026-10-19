import { serve } from "@hono/node-server";
import {
  AgentProfileError,
  claudeCodeCredentialFromEnv,
  createAgentRuntime,
  createAgentRuntimeApi,
  createClaudeCodeHarness,
  createFileTranscriptStore,
  createPostgresTaskStore,
  loadAgentProfiles,
  loadSkills,
  migrateAgentRuntimeStore,
} from "@tendworks/agent-runtime";
import { createPostgresEventBus, migrateEventBus } from "@tendworks/event-bus";
import { createHealthApi } from "@tendworks/health";
import { createSecretResolver, listsPlatformMcpServer } from "@tendworks/platform";
import {
  createExecutionEngineProbe,
  createFetchHttpExecutor,
  createOrchestrationApi,
  createPostgresRunStore,
  createRunActivities,
  createRunEventForwarder,
  createTemporalRunEngine,
  createTemporalRunWorker,
  migrateOrchestrationStore,
} from "@tendworks/orchestration";
import { createDockerSandboxApi, createSandboxBackendProbe, loadSandboxTemplates, SandboxTemplateError } from "@tendworks/sandbox";
import pg from "pg";

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`missing environment variable ${name}`);
  return value;
};

let profiles;
let templates;
let skills;
try {
  profiles = loadAgentProfiles(env("TEND_CONFIG_DIR"));
  templates = loadSandboxTemplates(env("TEND_CONFIG_DIR"));
  skills = loadSkills(env("TEND_CONFIG_DIR"));
} catch (error) {
  if (!(error instanceof AgentProfileError) && !(error instanceof SandboxTemplateError)) throw error;
  console.error(error.message);
  process.exit(1);
}

// Harness credentials: exactly the one TEND_CLAUDE_CODE_CREDENTIAL selects goes into sandboxes.
// Never log their values.
const selected = claudeCodeCredentialFromEnv(process.env);
if ("problem" in selected && profiles.some((profile) => profile.spec.harness === "claude-code")) {
  console.warn(`harness claude-code: ${selected.problem}; its tasks will fail until this is fixed`);
}
// Secrets agent profiles pass into sandboxes (spec.env): only TENDWORKS_AGENT_* variables
// resolve, so platform secrets never reach an agent (ADR 0008). Never log their values.
const secrets = createSecretResolver("agent", process.env);
for (const profile of profiles) {
  for (const [variable, { secretRef }] of Object.entries(profile.spec.env ?? {})) {
    const problem = secrets.problem(secretRef.name);
    if (problem) console.warn(`agent profile ${profile.metadata.name}: ${variable}: ${problem}; its tasks will fail until this is fixed`);
  }
}
// The platform MCP server (ADR 0016): its address as sandboxes reach it (configuration,
// since it depends on how sandboxes reach the server's published port) and the read-only
// token. Both go only to sessions of profiles that list it (mcp: [tendworks]); the API
// token never enters a sandbox. Never log the token.
const platformMcpUrl = process.env.TEND_PLATFORM_MCP_URL || undefined;
const readToken = process.env.TEND_API_READ_TOKEN || undefined;
const platformMcp = platformMcpUrl && readToken ? { url: platformMcpUrl, token: readToken } : undefined;
for (const profile of profiles) {
  if (listsPlatformMcpServer(profile) && !platformMcp) {
    console.warn(`agent profile ${profile.metadata.name}: lists the platform MCP server, but TEND_PLATFORM_MCP_URL or TEND_API_READ_TOKEN is not set; its tasks will fail until this is fixed`);
  }
}
const sandboxBackendUrl = env("TEND_SANDBOX_BACKEND_URL");
const claudeCode = createClaudeCodeHarness({
  sandboxes: createDockerSandboxApi({ url: sandboxBackendUrl, ...(process.env.TEND_SANDBOX_NETWORK ? { network: process.env.TEND_SANDBOX_NETWORK } : {}) }),
  templates: (name) => templates.get(name),
  credential: "credential" in selected ? selected.credential : undefined,
  skills,
  secrets,
  ...(platformMcp ? { platformMcp } : {}),
  ...(process.env.ANTHROPIC_BASE_URL ? { baseUrl: process.env.ANTHROPIC_BASE_URL } : {}),
});

const engineAddress = env("TEND_EXECUTION_ENGINE_ADDRESS");
const pool = new pg.Pool({ connectionString: env("TEND_DATABASE_URL") });
await migrateOrchestrationStore(pool);
await migrateAgentRuntimeStore(pool);
await migrateEventBus(pool);

// Run, step and chat events go onto the event bus in the transaction of the state they describe.
const bus = createPostgresEventBus({ pool });
// Orchestration reaches the agent runtime only through the A2A boundary (in process for now).
// Tasks are durable, so a task interrupted by a restart is resumed rather than started again.
const agents = createAgentRuntime({
  profiles,
  harnesses: { "claude-code": claudeCode },
  store: createPostgresTaskStore({ pool, publisher: bus }),
  transcripts: createFileTranscriptStore({ directory: env("TEND_TRANSCRIPT_DIR") }),
});
const store = createPostgresRunStore({ pool, publisher: bus });
const engine = await createTemporalRunEngine({ address: engineAddress });
// Other domains' events that name a run (e.g. approval.decided) go to that run, whose
// `listen` tasks receive them. The subscription's position survives restarts, so an event
// published while the worker was down is delivered when it is back.
const runEventForwarder = createRunEventForwarder(engine);
bus.subscribe("orchestration.run-events", runEventForwarder.handle.bind(runEventForwarder));
// `call: http` tasks may only reach the control plane API; workflows find it as
// `$runtime.metadata.controlPlaneUrl`. The merge step goes there, because the platform's
// repository token lives in the server bundle, never in this one.
// They authenticate with the platform's API token, which the executor adds; it never
// reaches a workflow definition or a sandbox.
const controlPlaneUrl = env("TEND_CONTROL_PLANE_URL");
const http = createFetchHttpExecutor({ allowedOrigin: controlPlaneUrl, apiToken: env("TEND_API_TOKEN") });
const runtime = { name: "tendworks", metadata: { controlPlaneUrl: controlPlaneUrl.replace(/\/+$/, "") } };
const runWorker = await createTemporalRunWorker({ address: engineAddress, activities: createRunActivities({ store, agents, http }) });

// Internal APIs for the control plane, never published: health (contracts/openapi/health.yaml),
// the agent runtime (contracts/openapi/agent-runtime.yaml) and orchestration (contracts/openapi/orchestration.yaml).
const health = createHealthApi({
  probes: [createExecutionEngineProbe(engineAddress), createSandboxBackendProbe(sandboxBackendUrl)],
});
const orchestration = createOrchestrationApi({ store, engine, runtime });
const agentRuntime = createAgentRuntimeApi({ runtime: agents });
const fetch = (request: Request) => {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") return health.fetch(request);
  if (pathname.startsWith("/tasks/") || pathname === "/chats" || pathname.startsWith("/chats/") || pathname === "/sessions") return agentRuntime.fetch(request);
  return orchestration.fetch(request);
};

const port = Number(env("PORT", "8081"));
const server = serve({ fetch, port }, () => console.log(`worker internal API listening on :${port}`));

// Chats have no run whose engine would resend their message after a restart: the agent
// runtime takes up their interrupted turns and idle times itself (ADR 0015).
agents.resumeChats().catch((error: unknown) => console.error("cannot resume chats:", error));

const stopped = runWorker.run().catch((error: unknown) => {
  console.error("run worker failed:", error);
  process.exit(1);
});

async function shutdown() {
  runWorker.shutdown();
  server.close();
  // Followed transcripts keep connections open; their clients reconnect with Last-Event-ID.
  if ("closeAllConnections" in server) server.closeAllConnections();
  await stopped;
  await bus.close();
  await Promise.all([engine.close(), pool.end()]);
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
