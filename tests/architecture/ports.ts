import {
  createAgentRuntime,
  createClaudeCodeHarness,
  createFakeHarness,
  createFileTranscriptStore,
  createInMemoryTaskStore,
  createInMemoryTranscriptStore,
  createPostgresTaskStore,
  createSandboxCleanup,
  createEmptyWorkspace,
  createGitWorkspace,
  type ChatEventPublisher,
  type Harness,
  type Sandboxes,
  type TaskStore,
  type TranscriptStore,
  type Workspace,
} from "@tendworks/agent-runtime";
import {
  createAgentRuntimeClient,
  createInMemoryAgentRuntime,
  createInMemoryApprovals,
  createInMemoryRuns,
  createInMemoryTriggers,
  createOrchestrationClient,
  createStoreProbe,
  createTriggerGatewayClient,
  type AgentRuntimePort,
  type ApprovalsPort,
  type NotificationsPort,
  type RunsPort,
  type TriggersPort,
} from "@tendworks/control-plane";
import { createInMemoryEventBus, createPostgresEventBus, type EventBus } from "@tendworks/event-bus";
import { createStaticHealthProbe, type HealthProbe } from "@tendworks/health";
import {
  createApprovals,
  createInMemoryApprovalStore,
  createInMemoryNotificationChannel,
  createInMemoryNotificationStore,
  createLoggingNotificationChannel,
  createPostgresApprovalStore,
  createPostgresNotificationStore,
  type ApprovalEventPublisher,
  type ApprovalStore,
  type NotificationChannel,
  type NotificationStore,
} from "@tendworks/human-interaction";
import {
  createExecutionEngineProbe,
  createFetchHttpExecutor,
  createInMemoryRunStore,
  createInProcessRunEngine,
  createPostgresOutbox as createOrchestrationOutbox,
  createPostgresRunStore,
  createTemporalRunEngine,
  InMemoryAgentTaskExecutor,
  InMemoryEventPublisher as InMemoryRunEventPublisher,
  InMemoryHttpExecutor,
  type AgentTaskExecutor,
  type EventPublisher as RunEventPublisher,
  type HttpExecutor,
  type RunEngine,
  type RunStore,
} from "@tendworks/orchestration";
import { createDockerSandboxApi, createFakeSandboxApi, createSandboxBackendProbe, type SandboxApi } from "@tendworks/sandbox";
import {
  createControlPlaneRunStarter,
  createFakeIssueTracker,
  createGithubIssueTracker,
  createInMemoryFiringStore,
  createInMemoryRunStarter,
  createPostgresFiringStore,
  createPostgresOutbox as createTriggerOutbox,
  InMemoryEventPublisher as InMemoryTriggerEventPublisher,
  type EventPublisher as TriggerEventPublisher,
  type FiringStore,
  type IssueTracker,
  type RunStarter,
} from "@tendworks/trigger-gateway";

/*
 * Every port (an interface tagged `@port`) with its implementations, keyed by
 * `<package>/<interface>`: at least the real adapter and a fake. An implementation is a
 * factory or class whose instances the type checker holds to the port; implementations
 * from another package fill a port structurally, as the bundles wire them. A port's
 * shared test suite, where it has one, runs against these implementations.
 */

type Implementation<Port> = ((...args: never[]) => Port | Promise<Port>) | (new (...args: never[]) => Port);

/** Names the implementations of `Port`; the type parameter is what the compiler checks them against. */
const port = <Port>(implementations: Record<string, Implementation<Port>>) => implementations;

export const PORTS: Record<string, Record<string, unknown>> = {
  "agent-runtime/Harness": port<Harness>({ "claude-code": createClaudeCodeHarness, fake: createFakeHarness }),
  "agent-runtime/TaskStore": port<TaskStore>({ postgres: createPostgresTaskStore, "in-memory": createInMemoryTaskStore }),
  "agent-runtime/TranscriptStore": port<TranscriptStore>({ files: createFileTranscriptStore, "in-memory": createInMemoryTranscriptStore }),
  "agent-runtime/Sandboxes": port<Sandboxes>({ docker: createDockerSandboxApi, fake: createFakeSandboxApi }),
  "agent-runtime/ChatEventPublisher": port<ChatEventPublisher<never>>({ "event-bus": createPostgresEventBus, "in-memory": createInMemoryEventBus }),
  "agent-runtime/Workspace": port<Workspace>({ git: createGitWorkspace, empty: createEmptyWorkspace }),

  "sandbox/SandboxApi": port<SandboxApi>({ docker: createDockerSandboxApi, fake: createFakeSandboxApi }),

  "orchestration/RunStore": port<RunStore>({ postgres: createPostgresRunStore, "in-memory": createInMemoryRunStore }),
  "orchestration/RunEngine": port<RunEngine>({ durable: createTemporalRunEngine, "in-process": createInProcessRunEngine }),
  "orchestration/EventPublisher": port<RunEventPublisher<never>>({ outbox: createOrchestrationOutbox, "in-memory": InMemoryRunEventPublisher }),
  "orchestration/AgentTaskExecutor": port<AgentTaskExecutor>({ "agent-runtime": createAgentRuntime, "in-memory": InMemoryAgentTaskExecutor }),
  "orchestration/HttpExecutor": port<HttpExecutor>({ fetch: createFetchHttpExecutor, "in-memory": InMemoryHttpExecutor }),

  "trigger-gateway/EventPublisher": port<TriggerEventPublisher<never>>({ outbox: createTriggerOutbox, "in-memory": InMemoryTriggerEventPublisher }),
  "trigger-gateway/FiringStore": port<FiringStore>({ postgres: createPostgresFiringStore, "in-memory": createInMemoryFiringStore }),
  "trigger-gateway/IssueTracker": port<IssueTracker>({ github: createGithubIssueTracker, fake: createFakeIssueTracker }),
  "trigger-gateway/RunStarter": port<RunStarter>({ "control-plane": createControlPlaneRunStarter, "in-memory": createInMemoryRunStarter }),

  "human-interaction/ApprovalEventPublisher": port<ApprovalEventPublisher<never>>({ "event-bus": createPostgresEventBus, "in-memory": createInMemoryEventBus }),
  "human-interaction/ApprovalStore": port<ApprovalStore>({ postgres: createPostgresApprovalStore, "in-memory": createInMemoryApprovalStore }),
  "human-interaction/NotificationStore": port<NotificationStore>({ postgres: createPostgresNotificationStore, "in-memory": createInMemoryNotificationStore }),
  "human-interaction/NotificationChannel": port<NotificationChannel>({ logging: createLoggingNotificationChannel, "in-memory": createInMemoryNotificationChannel }),

  "event-bus/EventBus": port<EventBus<never>>({ postgres: createPostgresEventBus, "in-memory": createInMemoryEventBus }),

  "control-plane/AgentRuntimePort": port<AgentRuntimePort>({ "agent-runtime": createAgentRuntimeClient, "in-memory": createInMemoryAgentRuntime }),
  "control-plane/RunsPort": port<RunsPort>({ orchestration: createOrchestrationClient, "in-memory": createInMemoryRuns }),
  "control-plane/TriggersPort": port<TriggersPort>({ "trigger-gateway": createTriggerGatewayClient, "in-memory": createInMemoryTriggers }),
  "control-plane/ApprovalsPort": port<ApprovalsPort>({ "human-interaction": createApprovals, "in-memory": createInMemoryApprovals }),
  "control-plane/NotificationsPort": port<NotificationsPort>({ "human-interaction": createPostgresNotificationStore, "in-memory": createInMemoryNotificationStore }),

  "health/HealthProbe": port<HealthProbe>({
    store: createStoreProbe,
    "execution-engine": createExecutionEngineProbe,
    "sandbox-backend": createSandboxBackendProbe,
    "sandbox-cleanup": createSandboxCleanup,
    static: createStaticHealthProbe,
  }),
};
