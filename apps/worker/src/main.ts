import { serve } from "@hono/node-server";
import {
  AGENT_SECRET_PREFIX,
  AgentProfileError,
  agentSecretsFromEnv,
  claudeCodeCredentialFromEnv,
  createAgentRuntime,
  createClaudeCodeHarness,
  createFileTranscriptStore,
  createPostgresTaskStore,
  loadAgentProfiles,
  loadSkills,
  migrateAgentRuntimeStore,
} from "@tendworks/agent-runtime";
import { createPostgresEventBus, migrateEventBus } from "@tendworks/event-bus";
import { createHealthApi } from "@tendworks/health";
import {
  createExecutionEngineProbe,
  createOrchestrationApi,
  createPostgresRunStore,
  createRunActivities,
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
// resolve, so platform secrets never reach an agent. Never log their values.
const secrets = agentSecretsFromEnv(process.env);
for (const profile of profiles) {
  for (const [variable, { secretRef }] of Object.entries(profile.spec.env ?? {})) {
    if (secrets(secretRef.name) === undefined) {
      console.warn(`agent profile ${profile.metadata.name}: ${variable} needs ${secretRef.name}, which is not set or not an agent secret (${AGENT_SECRET_PREFIX}*); its tasks will fail until it is set`);
    }
  }
}
const sandboxBackendUrl = env("TEND_SANDBOX_BACKEND_URL");
const claudeCode = createClaudeCodeHarness({
  sandboxes: createDockerSandboxApi({ url: sandboxBackendUrl }),
  templates: (name) => templates.get(name),
  credential: "credential" in selected ? selected.credential : undefined,
  skills,
  secrets,
  ...(process.env.ANTHROPIC_BASE_URL ? { baseUrl: process.env.ANTHROPIC_BASE_URL } : {}),
});

const engineAddress = env("TEND_EXECUTION_ENGINE_ADDRESS");
const pool = new pg.Pool({ connectionString: env("TEND_DATABASE_URL") });
await migrateOrchestrationStore(pool);
await migrateAgentRuntimeStore(pool);
await migrateEventBus(pool);

// Orchestration reaches the agent runtime only through the A2A boundary (in process for now).
// Tasks are durable, so a task interrupted by a restart is resumed rather than started again.
const agents = createAgentRuntime({
  profiles,
  harnesses: { "claude-code": claudeCode },
  store: createPostgresTaskStore({ pool }),
  transcripts: createFileTranscriptStore({ directory: env("TEND_TRANSCRIPT_DIR") }),
});
// Run and step events go onto the event bus in the transaction of the run state they describe.
const store = createPostgresRunStore({ pool, publisher: createPostgresEventBus({ pool }) });
const engine = await createTemporalRunEngine({ address: engineAddress });
const runWorker = await createTemporalRunWorker({ address: engineAddress, activities: createRunActivities({ store, agents }) });

// Internal APIs for the control plane, never published: health (contracts/openapi/health.yaml)
// and orchestration (contracts/openapi/orchestration.yaml).
const health = createHealthApi({
  probes: [createExecutionEngineProbe(engineAddress), createSandboxBackendProbe(sandboxBackendUrl)],
});
const orchestration = createOrchestrationApi({ store, engine });
const fetch = (request: Request) => (new URL(request.url).pathname === "/health" ? health.fetch(request) : orchestration.fetch(request));

const port = Number(env("PORT", "8081"));
const server = serve({ fetch, port }, () => console.log(`worker internal API listening on :${port}`));

const stopped = runWorker.run().catch((error: unknown) => {
  console.error("run worker failed:", error);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    runWorker.shutdown();
    server.close();
    await stopped;
    await Promise.all([engine.close(), pool.end()]);
    process.exit(0);
  });
}
