import { Link } from "./router.js";

const TABS = [
  { to: "/notifications", label: "Notifications" },
  { to: "/subscriptions", label: "Subscriptions" },
  { to: "/approval-requests", label: "Approval requests" },
] as const;

/** The inbox's title and its tabs (one route each); `current` is the path of the open tab. */
export function InboxTabs({ current }: { current: (typeof TABS)[number]["to"] }) {
  return (
    <>
      <h1>Inbox</h1>
      <nav aria-label="Inbox" className="inbox-tabs">
        {TABS.map((tab) => (
          <Link key={tab.to} to={tab.to} current={tab.to === current}>
            {tab.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
