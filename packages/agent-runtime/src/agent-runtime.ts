import { DEFAULT_CHAT_IDLE_MINUTES, newTraceparent, type WorkspaceAssistant } from "@tendworks/platform";
import type { A2A, AgentProfile } from "@tendworks/shared";
import type { LoadedAgentProfile } from "./agent-profiles.js";
import { AgentNotFoundError, COST, TRANSCRIPT, type AgentTasks, type SendMessageOptions } from "./agent-tasks.js";
import { chatEnded, chatStarted } from "./chat-events.js";
import {
  addCost,
  AssistantNotEnabledError,
  CHAT,
  chatBranch,
  ChatBusyError,
  ChatEndedError,
  chatFacts,
  ChatNotAllowedError,
  toChat,
  UnknownWorkspaceError,
  type Chat,
  type ChatFacts,
} from "./chats.js";
import { workspaceRequestOf, type Workspace } from "./workspace.js";
import { createFakeHarness } from "./fake-agent.js";
import type { Cost, Harness, HarnessResult, HarnessSession, HarnessTurn, OpenSession } from "./harness.js";
import { activeSession, runStepOf, type AgentSession } from "./sessions.js";
import { createInMemoryTaskStore, TERMINAL_STATES, type TaskStore } from "./task-store.js";
import { createLiveTranscripts } from "./transcripts/live-transcripts.js";
import {
  createInMemoryTranscriptStore,
  type Transcript,
  type TranscriptEntry,
  type TranscriptRecord,
  type TranscriptStore,
} from "./transcripts/transcript-store.js";

/** Task metadata key: how often the runtime resumed the task after an interruption. */
export const RESUMED = "dev.tendworks/resumed";

export type HarnessName = AgentProfile.AgentProfileSpec["harness"];

export interface AgentRuntimeOptions {
  profiles: LoadedAgentProfile[];
  /** Harnesses by the name agent profiles use in `spec.harness`. The fake agent (`fake`) is built in. */
  harnesses?: Partial<Record<HarnessName, Harness>>;
  /** Where tasks are kept; durable so tasks survive a restart. In memory by default. */
  store?: TaskStore;
  /** Where transcripts of agent sessions are kept; in memory by default. */
  transcripts?: TranscriptStore;
  /** Waiting, replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Waits for what is left of a chat's idle time; replaceable in tests. Does not keep the process alive. */
  idle?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** The configured workspaces by name (ADR 0022), e.g. from {@link createWorkspaces}; none by default. */
  workspaces?: (name: string) => Workspace | undefined;
  /** The enabled assistant of a configured workspace by the workspace's name, e.g. from {@link workspaceAssistants}; none by default. */
  assistants?: (workspace: string) => WorkspaceAssistant | undefined;
}

const TERMINAL: ReadonlySet<A2A.TaskState> = new Set(TERMINAL_STATES);

/** The agent runtime: the A2A boundary, and the transcripts of its tasks' agent sessions. */
export interface AgentRuntime extends AgentTasks {
  /** The transcript of a task's agent session so far, or undefined for a task without one. */
  transcript(taskId: string): Promise<TranscriptEntry[] | undefined>;
  /**
   * Follows the transcript of a task's agent session live (ADR 0017): the entries after
   * position `after` recorded so far, then each new one as it is recorded, until the task
   * ends; undefined for a task it does not know. A task that has not ended is followed
   * also while nobody works on it, e.g. until it is resumed after a restart. Ending the
   * iteration early (`return()`) stops following at once.
   */
  follow(taskId: string, options?: { after?: number }): Promise<AsyncIterableIterator<TranscriptEntry> | undefined>;
  /**
   * Starts a chat (ADR 0015): a task without a run whose agent session stays open across
   * turns, either with the agent profile `chatWith` in an empty workspace, or with the
   * assistant of the workspace `{ workspace }` (ADR 0022), held with the assistant's
   * profile and read-only unless the assistant may write. Answers at once with the chat
   * working on `message`; after each turn the task waits in `input-required`. Rejects for
   * an unknown profile, with {@link ChatNotAllowedError} for one without `spec.chat`, with
   * {@link UnknownWorkspaceError} for a workspace that is not configured and with
   * {@link AssistantNotEnabledError} for one without an enabled assistant. The same
   * message sent again returns the same chat.
   */
  startChat(chatWith: string | { workspace: string }, message: A2A.Message): Promise<Chat>;
  /**
   * The next message of a chat (A2A `SendMessage` to its task): starts the next turn in
   * the same agent session and answers at once. Rejects with {@link ChatBusyError}
   * while a turn runs and with {@link ChatEndedError} once the chat ended; undefined for
   * an unknown chat.
   */
  sendChatMessage(chatId: string, message: A2A.Message): Promise<Chat | undefined>;
  /**
   * Cancels the running turn of a chat without ending the chat: the agent is asked to
   * stop, and the answer comes once the turn has stopped, with the chat waiting for the
   * next message. While no turn runs the chat is returned as it is. Rejects with
   * {@link ChatEndedError} once the chat ended; undefined for an unknown chat.
   */
  cancelChatTurn(chatId: string): Promise<Chat | undefined>;
  /**
   * Ends a chat for good, also during a turn: its sandbox and volumes go, its
   * transcript stays. An ended chat is returned as it is; undefined for an unknown chat.
   */
  endChat(chatId: string): Promise<Chat | undefined>;
  getChat(chatId: string): Promise<Chat | undefined>;
  /** All chats, the most recently started first. */
  listChats(): Promise<Chat[]>;
  /** The agent sessions that have not ended, of runs' steps and of chats, the most recently started first. */
  listSessions(): Promise<AgentSession[]>;
  /**
   * Takes up the chats that have not ended, once after the process started (ADR 0004,
   * 0015): a turn a restart interrupted continues in the same agent session, and a chat
   * waiting for a message lets its sandbox go when its idle time is over. Resolves once
   * the interrupted turns are under way.
   */
  resumeChats(): Promise<void>;
}

/** A chat this process works on: its open agent session and what it records. */
interface OpenChat {
  profile: LoadedAgentProfile;
  facts: ChatFacts;
  session: OpenSession;
  task: A2A.Task;
  record: (entry: TranscriptRecord) => void;
  /** Resolves once everything recorded so far is kept. */
  written: () => Promise<void>;
  /** The running turn, if any. */
  turn?: Promise<void>;
  /** Set once the chat is being ended; a turn that ends then leaves the outcome to the end. */
  ending?: Promise<Chat>;
  /** Counts the times the chat began waiting for a message, so only the latest wait lets the sandbox go. */
  waits: number;
  /** Letting go of the sandbox after the idle time, while it happens. */
  suspending?: Promise<void>;
}

/** A workspace removed from the configuration since a chat on it started: every turn fails, naming it. */
function missingWorkspace(name: string): Workspace {
  return { prepare: async () => ({ problem: `no workspace '${name}' is configured` }) };
}

/**
 * Accepts A2A tasks and hands each to the harness its agent profile names, recording
 * the session's transcript and cost. A message whose task exists already returns that
 * task: a finished one as it is, one that was interrupted (e.g. by a restart) is
 * resumed, never started again.
 */
export function createAgentRuntime({
  profiles,
  harnesses = {},
  store = createInMemoryTaskStore(),
  transcripts = createInMemoryTranscriptStore(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  idle = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
  now = () => new Date(),
  workspaces = () => undefined,
  assistants = () => undefined,
}: AgentRuntimeOptions): AgentRuntime {
  const byName = new Map(profiles.map((profile) => [profile.metadata.name, profile]));
  const available: Partial<Record<HarnessName, Harness>> = { fake: createFakeHarness({ sleep }), ...harnesses };
  // Tasks this process is working on, so a repeated message joins the running work.
  const inProgress = new Map<string, Promise<A2A.Task>>();
  // Progress of running tasks; only the start and the end are written to the store.
  const working = new Map<string, A2A.Task>();
  const live = createLiveTranscripts();
  // Chats with an open agent session in this process, and those working on a turn.
  const chats = new Map<string, OpenChat>();
  const busy = new Set<string>();

  /** Records entries of a task's transcript in order: stamps the time, keeps them and tells live followers. */
  function recorder(taskId: string, transcript: Transcript) {
    let writes = Promise.resolve();
    const record = (entry: TranscriptRecord) => {
      const stamped = { time: now().toISOString(), ...entry };
      writes = writes.then(async () => live.recorded(taskId, await transcript.append(stamped)));
    };
    return { record, written: () => writes };
  }

  const agentMessage = (taskId: string, text: string, suffix = "status"): A2A.Message => ({
    messageId: `${taskId}/${suffix}`,
    taskId,
    role: "ROLE_AGENT",
    parts: [{ text }],
  });

  /** Opens the agent session of a chat this process has not held yet, e.g. after a restart. */
  function openChat(profile: LoadedAgentProfile, task: A2A.Task, facts: ChatFacts, session?: HarnessSession): OpenChat {
    const harness = available[profile.spec.harness];
    if (!harness?.open) throw new ChatNotAllowedError(profile.metadata.name, `harness ${profile.spec.harness} cannot hold a session across turns`);
    const { record, written } = recorder(task.id, transcripts.open(task.id));
    // The workspace whose assistant the chat is, read-only unless the assistant may write (then on the chat's own branch).
    const inWorkspace =
      facts.workspace === undefined
        ? {}
        : {
            workspace: workspaces(facts.workspace) ?? missingWorkspace(facts.workspace),
            ...(facts.write ? { branch: chatBranch(task.id) } : { readOnlyWorkspace: true }),
          };
    const chat: OpenChat = {
      profile,
      facts,
      task,
      record,
      written,
      waits: 0,
      session: harness.open(
        { taskId: task.id, profile, ...(session ? { session } : {}), ...inWorkspace },
        { record, progress: () => {}, saveSession: (kept) => store.saveSession(task.id, kept) },
      ),
    };
    chats.set(task.id, chat);
    return chat;
  }

  /**
   * Lets the chat's sandbox go once nobody answered for the profile's idle time (ADR 0015),
   * counted from `since`; the volumes stay and the next message resumes the session.
   */
  function idleAfterwards(chat: OpenChat, since: Date): void {
    const wait = ++chat.waits;
    const idleMs = (chat.profile.spec.chat?.idleMinutes ?? DEFAULT_CHAT_IDLE_MINUTES) * 60_000;
    void idle(Math.max(0, idleMs - (now().getTime() - since.getTime()))).then(async () => {
      const id = chat.task.id;
      if (chat.waits !== wait || chat.ending || busy.has(id) || chats.get(id) !== chat) return;
      chat.suspending = chat.session.suspend().catch((error: unknown) => {
        chat.record({ type: "error", message: `cannot remove the idle chat's sandbox: ${error instanceof Error ? error.message : String(error)}` });
      });
      await chat.suspending;
    });
  }

  /** Runs one turn of a chat in the background; afterwards the chat waits for the next message, or failed. */
  function startTurn(chat: OpenChat, message: A2A.Message, options: { interrupted?: boolean } = {}): void {
    const id = chat.task.id;
    chat.waits++;
    chat.turn = (async () => {
      let result: HarnessTurn;
      try {
        // A sandbox being let go goes first; the turn then resumes the session in a new one.
        await chat.suspending;
        result = await chat.session.turn(message, options);
      } catch (error) {
        result = { state: "TASK_STATE_FAILED", message: `the agent session failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (chat.ending) return;
      if (result.state === "TASK_STATE_FAILED") {
        await finishChat(chat, "TASK_STATE_FAILED", result.message);
        return;
      }
      const cost = addCost(chat.task.metadata?.[COST] as Cost | undefined, result.cost);
      const reply = agentMessage(id, result.message, `turn-${chat.task.history?.length ?? 0}`);
      const waitingTask: A2A.Task = {
        ...chat.task,
        status: { state: "TASK_STATE_INPUT_REQUIRED", message: reply, timestamp: now().toISOString() },
        history: [...(chat.task.history ?? []), reply],
        metadata: { ...chat.task.metadata, ...(cost ? { [COST]: cost } : {}) },
      };
      await store.update(waitingTask);
      // Shown as waiting only together with accepting the next message, and before the entry
      // is visible, so a client that saw either is not refused.
      chat.task = waitingTask;
      busy.delete(id);
      chat.record({ type: "input-required", message: result.message, ...(cost ? { cost } : {}) });
      idleAfterwards(chat, now());
    })().catch(() => {
      // The store failed; the chat stays working until a restart takes it up (ADR 0004).
    });
  }

  /** Ends a chat for good: its agent session goes with sandbox and volumes, the task ends, the transcript stays. */
  async function finishChat(chat: OpenChat, state: "TASK_STATE_COMPLETED" | "TASK_STATE_FAILED", text: string): Promise<Chat> {
    const id = chat.task.id;
    try {
      await chat.session.end();
    } catch (error) {
      chat.record({ type: "error", message: `cannot remove the chat's sandbox or volumes: ${error instanceof Error ? error.message : String(error)}` });
    }
    const cost = chat.task.metadata?.[COST] as Cost | undefined;
    chat.record({ type: "task-ended", state, message: text, ...(cost ? { cost } : {}) });
    await chat.written();
    chat.task = { ...chat.task, status: { state, message: agentMessage(id, text), timestamp: now().toISOString() } };
    await store.update(chat.task, chatEnded({ chatId: id, time: chat.task.status.timestamp!, ...chat.facts }, state === "TASK_STATE_COMPLETED" ? "ended" : "failed"));
    chats.delete(id);
    busy.delete(id);
    live.ended(id);
    return toChat(chat.task, chat.facts);
  }

  /**
   * The profile of a chat; for one removed from the configuration since the chat started,
   * a stand-in naming only the harness, enough to end the chat's session but never to run a
   * turn. Undefined when the harness of a removed profile is not known.
   */
  function chatProfile(facts: ChatFacts): LoadedAgentProfile | undefined {
    const profile = byName.get(facts.agent);
    if (profile || facts.harness === undefined) return profile;
    return { apiVersion: "tendworks.dev/v1", kind: "AgentProfile", metadata: { name: facts.agent }, spec: { harness: facts.harness as HarnessName } };
  }

  /** A chat's task with its profile, or undefined when the task is no chat. */
  async function findChat(chatId: string): Promise<{ task: A2A.Task; facts: ChatFacts } | undefined> {
    const task = chats.get(chatId)?.task ?? (await store.get(chatId));
    const facts = task && chatFacts(task);
    return task && facts ? { task, facts } : undefined;
  }

  /** The configured workspace the message that starts a task names, with its branch; a problem for a malformed or unknown one. */
  function workspaceFor(message: A2A.Message): { workspace?: Workspace; branch?: string } | { problem: string } {
    const requested = workspaceRequestOf(message);
    if ("problem" in requested) return requested;
    if (!requested.request) return {};
    const { name, branch } = requested.request;
    const workspace = workspaces(name);
    if (!workspace) return { problem: `no workspace '${name}' is configured` };
    return { workspace, ...(branch === undefined ? {} : { branch }) };
  }

  async function work(profile: LoadedAgentProfile, request: A2A.SendMessageRequest, { onTask }: SendMessageOptions = {}): Promise<A2A.Task> {
    const startedAt = now();
    const taskId = crypto.randomUUID();
    const runStep = runStepOf(request.metadata);
    const claimed = await store.claim({
      messageId: request.message.messageId,
      agent: profile.metadata.name,
      startedAt: startedAt.toISOString(),
      task: {
        id: taskId,
        ...(request.message.contextId === undefined ? {} : { contextId: request.message.contextId }),
        status: { state: "TASK_STATE_WORKING", timestamp: startedAt.toISOString() },
        history: [request.message],
        ...(runStep ? { metadata: runStep } : {}),
      },
    });
    if (TERMINAL.has(claimed.task.status.state)) return claimed.task;

    const id = claimed.task.id;
    const transcript = transcripts.open(id);
    // A task kept before it named its run and step learns them when it is resumed.
    let metadata: Record<string, unknown> = { ...claimed.task.metadata, ...runStep, [TRANSCRIPT]: transcript.ref };
    if (id !== taskId) {
      // Known but unfinished: this process did not start it, so it was interrupted.
      metadata = { ...metadata, [RESUMED]: Number(metadata[RESUMED] ?? 0) + 1 };
    }
    await store.update({ ...claimed.task, metadata });
    try {
      await onTask?.({ ...claimed.task, metadata });
    } catch {
      // Taking note of the task is the sender's concern; the task goes on regardless.
    }

    const { record, written } = recorder(id, transcript);
    const withStatus = (state: A2A.TaskState, text: string): A2A.Task => ({
      ...claimed.task,
      history: claimed.task.history ?? [request.message],
      status: {
        state,
        message: { messageId: `${id}/status`, taskId: id, role: "ROLE_AGENT", parts: [{ text }] },
        timestamp: now().toISOString(),
      },
      metadata,
    });

    record({ type: id === taskId ? "task-started" : "task-resumed", agent: profile.metadata.name, message: request.message });
    const harness = available[profile.spec.harness];
    const requested = workspaceFor(request.message);
    let result: HarnessResult;
    if (!harness) {
      result = { state: "TASK_STATE_FAILED", message: `harness ${profile.spec.harness} is not available in this agent runtime` };
    } else if ("problem" in requested) {
      result = { state: "TASK_STATE_FAILED", message: requested.problem };
    } else {
      try {
        result = await harness.run(
          {
            taskId: id,
            profile,
            message: request.message,
            elapsedMs: id === taskId ? 0 : now().getTime() - Date.parse(claimed.startedAt),
            ...(claimed.session ? { session: claimed.session } : {}),
            ...requested,
          },
          {
            record,
            progress: (text) => working.set(id, withStatus("TASK_STATE_WORKING", text)),
            saveSession: (session) => store.saveSession(id, session),
          },
        );
      } finally {
        working.delete(id);
      }
    }

    record({ type: "task-ended", state: result.state, message: result.message, ...(result.cost ? { cost: result.cost } : {}) });
    await written();
    if (result.cost) metadata = { ...metadata, [COST]: { ...result.cost } };
    const done: A2A.Task = { ...withStatus(result.state, result.message), ...(result.artifacts ? { artifacts: result.artifacts } : {}) };
    await store.update(done);
    live.ended(id);
    return done;
  }

  return {
    sendMessage(agent, request, options) {
      const profile = byName.get(agent);
      if (!profile) return Promise.reject(new AgentNotFoundError(agent));
      const known = inProgress.get(request.message.messageId);
      if (known) return known;
      const task = work(profile, request, options);
      inProgress.set(request.message.messageId, task);
      // Settled tasks are found in the store; a failed delivery may be retried.
      void task.finally(() => inProgress.delete(request.message.messageId)).catch(() => {});
      return task;
    },
    async getTask(taskId) {
      // The store is the truth once the task ended, possibly in another process after a restart.
      const stored = await store.get(taskId);
      if (stored && TERMINAL.has(stored.status.state)) return stored;
      return working.get(taskId) ?? stored;
    },
    async transcript(taskId) {
      const ref = (await store.get(taskId))?.metadata?.[TRANSCRIPT];
      return typeof ref === "string" ? transcripts.read(ref) : undefined;
    },
    async follow(taskId, { after = -1 } = {}) {
      // Subscribed before reading, so nothing recorded in between is missed.
      const following = live.follow(taskId, after);
      try {
        const stored = await store.get(taskId);
        if (!stored) {
          following.close();
          return undefined;
        }
        const ref = stored.metadata?.[TRANSCRIPT];
        const history = typeof ref === "string" ? ((await transcripts.read(ref)) ?? []) : [];
        return following.start(history, TERMINAL.has(stored.status.state));
      } catch (error) {
        following.close();
        throw error;
      }
    },
    async startChat(chatWith, message) {
      let agent: string;
      let inWorkspace: Pick<ChatFacts, "workspace" | "write"> = {};
      if (typeof chatWith === "string") {
        agent = chatWith;
      } else {
        const { workspace } = chatWith;
        if (!workspaces(workspace)) throw new UnknownWorkspaceError(workspace);
        const assistant = assistants(workspace);
        if (!assistant) throw new AssistantNotEnabledError(workspace);
        agent = assistant.profile;
        inWorkspace = { workspace, write: assistant.write };
      }
      const profile = byName.get(agent);
      if (!profile) throw new AgentNotFoundError(agent);
      if (!profile.spec.chat) throw new ChatNotAllowedError(agent);
      if (!available[profile.spec.harness]?.open) throw new ChatNotAllowedError(agent, `harness ${profile.spec.harness} cannot hold a session across turns`);

      const id = crypto.randomUUID();
      const startedAt = now().toISOString();
      const facts: ChatFacts = { agent, harness: profile.spec.harness, startedAt, traceparent: newTraceparent(), ...inWorkspace };
      const claimed = await store.claim(
        {
          messageId: message.messageId,
          agent,
          startedAt,
          kind: "chat",
          task: {
            id,
            ...(message.contextId === undefined ? {} : { contextId: message.contextId }),
            status: { state: "TASK_STATE_WORKING", timestamp: startedAt },
            history: [{ ...message, taskId: id }],
            metadata: { [TRANSCRIPT]: transcripts.open(id).ref, [CHAT]: facts },
          },
        },
        chatStarted({ chatId: id, time: startedAt, ...facts }),
      );
      const known = chatFacts(claimed.task);
      // The same message sent again: the chat it started.
      if (claimed.task.id !== id) {
        if (!known) throw new Error(`message ${message.messageId} started a task that is no chat`);
        return toChat(claimed.task, known);
      }
      busy.add(id);
      const chat = openChat(profile, claimed.task, facts);
      chat.record({ type: "task-started", agent, message });
      startTurn(chat, message);
      return toChat(chat.task, facts);
    },
    async sendChatMessage(chatId, message) {
      const found = await findChat(chatId);
      if (!found) return undefined;
      if (TERMINAL.has(found.task.status.state) || chats.get(chatId)?.ending) throw new ChatEndedError(chatId);
      if (busy.has(chatId) || found.task.status.state === "TASK_STATE_WORKING") throw new ChatBusyError(chatId);
      // Taken before anything else is awaited, so of two messages at once only one gets through.
      busy.add(chatId);
      try {
        let chat = chats.get(chatId);
        if (!chat) {
          // A chat this process does not hold yet, e.g. after a restart: its session resumes with the turn.
          const profile = byName.get(found.facts.agent);
          if (!profile) throw new AgentNotFoundError(found.facts.agent);
          chat = openChat(profile, found.task, found.facts, (await store.find(chatId))?.session);
        }
        const received = { ...message, taskId: chatId };
        chat.task = {
          ...chat.task,
          status: { state: "TASK_STATE_WORKING", timestamp: now().toISOString() },
          history: [...(chat.task.history ?? []), received],
        };
        await store.update(chat.task);
        chat.record({ type: "message-received", message });
        startTurn(chat, message);
        return toChat(chat.task, chat.facts);
      } catch (error) {
        busy.delete(chatId);
        throw error;
      }
    },
    async cancelChatTurn(chatId) {
      const found = await findChat(chatId);
      if (!found) return undefined;
      const chat = chats.get(chatId);
      if (TERMINAL.has(found.task.status.state) || chat?.ending) throw new ChatEndedError(chatId);
      // A turn this process does not work on cannot be cancelled here, e.g. one interrupted by a restart.
      if (!chat?.turn || !busy.has(chatId)) return toChat(found.task, found.facts);
      await chat.session.cancel();
      await chat.turn;
      return toChat(chat.task, chat.facts);
    },
    async endChat(chatId) {
      const found = await findChat(chatId);
      if (!found) return undefined;
      if (TERMINAL.has(found.task.status.state)) return toChat(found.task, found.facts);
      let chat = chats.get(chatId);
      if (chat?.ending) return chat.ending;
      if (!chat) {
        // Also a chat whose profile is gone: its session is ended from what was kept of it.
        const profile = chatProfile(found.facts);
        if (!profile) throw new AgentNotFoundError(found.facts.agent);
        chat = openChat(profile, found.task, found.facts, (await store.find(chatId))?.session);
      }
      const ending = finishChat(chat, "TASK_STATE_COMPLETED", "the chat was ended");
      chat.ending = ending;
      return ending;
    },
    async getChat(chatId) {
      const found = await findChat(chatId);
      return found && toChat(found.task, found.facts);
    },
    async listChats() {
      return (await store.list({ kind: "chat" })).flatMap((task) => {
        const current = chats.get(task.id)?.task ?? task;
        const facts = chatFacts(current);
        return facts ? [toChat(current, facts)] : [];
      });
    },
    async listSessions() {
      return (await store.active()).flatMap((stored) => {
        const session = activeSession({ ...stored, task: chats.get(stored.task.id)?.task ?? stored.task });
        return session ? [session] : [];
      });
    },
    async resumeChats() {
      for (const listed of await store.list({ kind: "chat" })) {
        if (chats.has(listed.id) || TERMINAL.has(listed.status.state)) continue;
        const stored = await store.find(listed.id);
        const facts = stored && chatFacts(stored.task);
        if (!stored || !facts) continue;
        const profile = byName.get(facts.agent);
        if (!profile) {
          // The profile is gone from the configuration: the chat cannot go on, its session goes.
          const removed = chatProfile(facts);
          if (!removed || !available[removed.spec.harness]?.open) continue;
          await finishChat(openChat(removed, stored.task, facts, stored.session), "TASK_STATE_FAILED", `agent profile ${facts.agent} is no longer configured; the chat cannot go on`);
          continue;
        }
        if (!available[profile.spec.harness]?.open) continue;
        const chat = openChat(profile, stored.task, facts, stored.session);
        const interrupted = stored.task.status.state === "TASK_STATE_WORKING" && stored.task.history?.findLast((message) => message.role === "ROLE_USER");
        if (interrupted) {
          busy.add(chat.task.id);
          chat.record({ type: "task-resumed", agent: facts.agent, message: interrupted });
          startTurn(chat, interrupted, { interrupted: true });
        } else {
          idleAfterwards(chat, new Date(stored.task.status.timestamp ?? facts.startedAt));
        }
      }
    },
  };
}
