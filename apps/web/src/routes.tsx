import type { ReactNode } from "react";
import { ApprovalRequestsPage } from "./approvals.js";
import { ChatWindow } from "./chat-window.js";
import { ChatList } from "./chats.js";
import { NewChat } from "./new-chat.js";
import { NotificationsPage } from "./notifications.js";
import { match } from "./router.js";
import { RunDetail } from "./run-detail.js";
import { RunList } from "./runs.js";
import { StatusPage } from "./status.js";

/*
 * The views of the UI (spec #38) and their paths below /ui; the navigation lists the views
 * with `nav`.
 */

interface Route {
  pattern: string;
  /** The page title, and the navigation label for views in the navigation. */
  title: string;
  /** Which navigation entry is current on this route. */
  section: string;
  nav?: boolean;
  render(parameters: Record<string, string>): ReactNode;
}

export const routes: readonly Route[] = [
  { pattern: "/", title: "Status", section: "/", nav: true, render: () => <StatusPage /> },
  { pattern: "/runs", title: "Runs", section: "/runs", nav: true, render: () => <RunList /> },
  { pattern: "/runs/:runId", title: "Run", section: "/runs", render: ({ runId = "" }) => <RunDetail key={runId} runId={runId} /> },
  { pattern: "/approval-requests", title: "Approval requests", section: "/approval-requests", nav: true, render: () => <ApprovalRequestsPage /> },
  { pattern: "/notifications", title: "Notifications", section: "/notifications", nav: true, render: () => <NotificationsPage /> },
  { pattern: "/chats", title: "Chats", section: "/chats", nav: true, render: () => <ChatList /> },
  { pattern: "/chats/new", title: "New chat", section: "/chats", render: () => <NewChat /> },
  { pattern: "/chats/:chatId", title: "Chat", section: "/chats", render: ({ chatId = "" }) => <ChatWindow key={chatId} chatId={chatId} /> },
];

/** The route for `path` with its parameters, or `undefined` for a path the UI does not know. */
export function resolve(path: string): { route: Route; parameters: Record<string, string> } | undefined {
  for (const route of routes) {
    const parameters = match(route.pattern, path);
    if (parameters) return { route, parameters };
  }
  return undefined;
}
