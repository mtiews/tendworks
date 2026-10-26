import { shortTitle } from "@tendworks/platform";
import type { ControlPlane } from "@tendworks/shared";

/*
 * How the workbench presents a chat (spec #101): derived from the chat as the API gives it,
 * the way run-summary.ts does for runs.
 */

export type Chat = ControlPlane.components["schemas"]["chat"];

/** Whether the chat still takes messages. */
export const isOpen = (chat: Chat) => chat.status === "working" || chat.status === "input-required";

/** The chat's name where space is short: its first message on one line. */
export const chatTitle = (chat: Chat) => shortTitle(chat.title, 80);

/** The chats by whether they continue: open ones first, each group in the API's order (newest first). */
export function groupChats(chats: readonly Chat[]): { open: Chat[]; ended: Chat[] } {
  return { open: chats.filter(isOpen), ended: chats.filter((chat) => !isOpen(chat)) };
}

/** The chat a desktop workbench opens without one chosen: the newest open one, else the newest. */
export function defaultChat(chats: readonly Chat[]): Chat | undefined {
  return chats.find(isOpen) ?? chats[0];
}

/** Whether `filter` finds the chat by its title, agent, workspace or id (case-insensitive). */
export function matchesChatFilter(chat: Chat, filter: string): boolean {
  const wanted = filter.trim().toLowerCase();
  if (wanted === "") return true;
  return [chat.title, chat.agent, chat.workspace, chat.id].some((text) => text?.toLowerCase().includes(wanted));
}

/** What the list shows of a chat: at work, failed, else calm. */
export const stateOf = (chat: Chat) => (chat.status === "working" ? "running" : chat.status === "failed" ? "failed" : "idle");
