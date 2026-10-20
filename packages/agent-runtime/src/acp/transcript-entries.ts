import type * as acp from "@agentclientprotocol/sdk";
import type { TranscriptRecord } from "../transcripts/transcript-store.js";

type ToolKind = Extract<TranscriptRecord, { type: "tool-call" }>["kind"];
type TurnEnd = Extract<TranscriptRecord, { type: "turn-ended" }>["reason"];
type PlanStatus = Extract<TranscriptRecord, { type: "plan" }>["steps"][number]["status"];

const TOOL_KINDS: ReadonlySet<string> = new Set<NonNullable<ToolKind>>(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"]);

const TURN_ENDS: Record<acp.StopReason, TurnEnd> = {
  end_turn: "completed",
  cancelled: "cancelled",
  refusal: "refused",
  max_tokens: "token-limit",
  max_turn_requests: "request-limit",
};

const PLAN_STATUS: Record<acp.PlanEntryStatus, PlanStatus> = { pending: "pending", in_progress: "in-progress", completed: "completed" };

/** How the agent ended its turn, as a transcript entry. */
export const turnEnded = (stopReason: acp.StopReason): TranscriptRecord => ({ type: "turn-ended", reason: TURN_ENDS[stopReason] });

/**
 * Maps an ACP session update onto product-neutral transcript entries (ADR 0017), with
 * secrets removed from every text. Updates that say nothing about the agent's work
 * (modes, commands, session metadata, …) and intermediate tool states map to none.
 */
export function transcriptEntries(update: acp.SessionUpdate, redact: (text: string) => string): TranscriptRecord[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return update.content.type === "text" ? [{ type: "message-chunk", text: redact(update.content.text) }] : [];
    case "agent_thought_chunk":
      return update.content.type === "text" ? [{ type: "thought-chunk", text: redact(update.content.text) }] : [];
    case "tool_call": {
      const kind: NonNullable<ToolKind> | undefined = update.kind && (TOOL_KINDS.has(update.kind) ? (update.kind as NonNullable<ToolKind>) : "other");
      return [{ type: "tool-call", toolCallId: update.toolCallId, title: redact(update.title), ...(kind ? { kind } : {}) }];
    }
    case "tool_call_update": {
      if (update.status !== "completed" && update.status !== "failed") return [];
      const output = (update.content ?? []).flatMap(describe).join("\n");
      return [{ type: "tool-result", toolCallId: update.toolCallId, status: update.status, ...(output ? { output: redact(output) } : {}) }];
    }
    case "plan":
      return [{ type: "plan", steps: update.entries.map(({ content, status }) => ({ content: redact(content), status: PLAN_STATUS[status] })) }];
    case "usage_update":
      return update.cost ? [{ type: "usage", cost: { amount: update.cost.amount, currency: update.cost.currency } }] : [];
    // Nothing about the agent's work: echoed user input, plan edits the next `plan` repeats,
    // modes, commands, configuration, session metadata, compaction, subagents and notices.
    case "user_message_chunk":
    case "plan_update":
    case "plan_removed":
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "session_message":
    case "session_message_chunk":
    case "compaction_summary_chunk":
    case "compaction_update":
    case "subagent_update":
    case "notice":
      return [];
  }
}

/** A tool call's content as text: what it returned, or which file it changed. */
function describe(content: acp.ToolCallContent): string[] {
  switch (content.type) {
    case "content":
      return content.content.type === "text" ? [content.content.text] : [];
    case "diff":
      return [`changed ${content.path}`];
    case "terminal":
      return [];
  }
}
