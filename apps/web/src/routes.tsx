import type { ReactNode } from "react";
import { AgentsPage } from "./agents.js";
import { ApprovalRequestsPage } from "./approvals.js";
import { ChatWorkbench } from "./chats.js";
import { NotificationsPage } from "./notifications.js";
import { MorePage } from "./more.js";
import { match } from "./router.js";
import { RunWorkbench } from "./runs.js";
import { startPage } from "./start-page.js";
import { OverviewPage } from "./overview.js";
import { SubscriptionsPage } from "./subscriptions.js";
import { TriggersPage } from "./triggers.js";
import { WorkspacesPage } from "./workspaces.js";

/*
 * The views of the UI and their paths below /ui (ADR 0027). `section` is the navigation
 * entry a view belongs to; `back` is where the phone's back button leads from a detail view.
 * "/" is not a view: it shows the start page (see `resolve`).
 */

export type Section = "overview" | "runs" | "chats" | "inbox" | "triggers" | "agents" | "workspaces" | "more";

/** What the shell lends to the views that need it. */
export interface ShellActions {
  signOut: () => void;
  /** The phone layout shows (it has no sign-out button in the navigation). */
  phone: boolean;
}

export interface Route {
  pattern: string;
  /** The page title. */
  title: string;
  section: Section;
  back?: string;
  /** The view uses the whole width beside the navigation (the workbench), not the reading width. */
  wide?: boolean;
  render(parameters: Record<string, string>, shell: ShellActions): ReactNode;
}

export const routes: readonly Route[] = [
  { pattern: "/more", title: "More", section: "more", render: (_, { signOut, phone }) => <MorePage signOut={signOut} showSignOut={phone} /> },
  { pattern: "/overview", title: "Overview", section: "overview", render: (_, { phone }) => <OverviewPage phone={phone} /> },
  { pattern: "/runs", title: "Runs", section: "runs", wide: true, render: (_, { phone }) => <RunWorkbench phone={phone} /> },
  { pattern: "/runs/:runId", title: "Run", section: "runs", back: "/runs", wide: true, render: ({ runId = "" }, { phone }) => <RunWorkbench runId={runId} phone={phone} /> },
  { pattern: "/chats", title: "Chats", section: "chats", wide: true, render: (_, { phone }) => <ChatWorkbench phone={phone} /> },
  { pattern: "/chats/new", title: "New chat", section: "chats", back: "/chats", wide: true, render: (_, { phone }) => <ChatWorkbench creating phone={phone} /> },
  { pattern: "/chats/:chatId", title: "Chat", section: "chats", back: "/chats", wide: true, render: ({ chatId = "" }, { phone }) => <ChatWorkbench chatId={chatId} phone={phone} /> },
  { pattern: "/notifications", title: "Notifications", section: "inbox", render: () => <NotificationsPage /> },
  { pattern: "/subscriptions", title: "Subscriptions", section: "inbox", render: () => <SubscriptionsPage /> },
  { pattern: "/triggers", title: "Triggers", section: "triggers", back: "/more", render: (_, { phone }) => <TriggersPage phone={phone} /> },
  { pattern: "/agents", title: "Agents", section: "agents", back: "/more", render: () => <AgentsPage /> },
  { pattern: "/workspaces", title: "Workspaces", section: "workspaces", back: "/more", render: () => <WorkspacesPage /> },
  { pattern: "/approval-requests", title: "Approval requests", section: "inbox", render: () => <ApprovalRequestsPage /> },
];

/** The route for `path` with its parameters, or `undefined` for a path the UI does not know. `/` shows the chosen start page. */
export function resolve(path: string): { route: Route; parameters: Record<string, string> } | undefined {
  if (path === "/") return resolve(`/${startPage()}`);
  for (const route of routes) {
    const parameters = match(route.pattern, path);
    if (parameters) return { route, parameters };
  }
  return undefined;
}
