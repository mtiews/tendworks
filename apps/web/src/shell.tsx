import { useEffect } from "react";
import { useApi } from "./api.js";
import { BrandMark } from "./brand-mark.js";
import { Icon, type IconName } from "./icons.js";
import { useNavigationBadges, type NavigationBadges } from "./navigation-badges.js";
import { resolve, type Section } from "./routes.js";
import { Link, useLocation } from "./router.js";
import { usePhone } from "./use-phone.js";

interface Entry {
  section: Section;
  to: string;
  label: string;
  icon: IconName;
}

/* The same five places on the desktop rail and the phone's bottom tabs; "More" holds the rest. */
const ENTRIES: readonly Entry[] = [
  { section: "overview", to: "/overview", label: "Overview", icon: "overview" },
  { section: "runs", to: "/runs", label: "Runs", icon: "runs" },
  { section: "chats", to: "/chats", label: "Chats", icon: "chats" },
  { section: "inbox", to: "/notifications", label: "Inbox", icon: "inbox" },
  { section: "more", to: "/more", label: "More", icon: "more" },
];

/** The signed-in app: navigation (icon rail, or top bar and bottom tabs on a phone), the access scope, and the current view. */
export function Shell({ signOut }: { signOut: () => void }) {
  const { canChange } = useApi();
  const { path } = useLocation();
  const phone = usePhone();
  const found = resolve(path);
  const badges = useNavigationBadges();

  useEffect(() => {
    document.title = `${found?.route.title ?? "Not found"} · Tendworks`;
  }, [found?.route.title]);

  const scope = (
    <span className={`scope scope-${canChange ? "full" : "read"}`} title={canChange ? "Signed in with the API token." : "Signed in with the read-only token: the UI only shows."}>
      {canChange ? "Full access" : "Read-only"}
    </span>
  );
  const back = found?.route.back;

  return (
    <div className={`shell ${phone ? "shell-phone" : "shell-desktop"}`}>
      <header className="top-bar">
        {phone && (back ? <BackLink to={back} /> : <Link to="/" className="wordmark" label="Tendworks"><BrandMark size={26} /><span aria-hidden="true">Tendworks</span></Link>)}
        {scope}
      </header>
      <Navigation phone={phone} section={found?.route.section} badges={badges} signOut={signOut} />
      <main className="content">
        {found ? (
          found.route.render(found.parameters, { signOut, phone })
        ) : (
          <>
            <h1>Not found</h1>
            <p className="muted">
              The UI has no page at this address. <Link to="/">Go to the start page</Link>.
            </p>
          </>
        )}
      </main>
    </div>
  );
}

function BackLink({ to }: { to: string }) {
  return (
    <Link to={to} className="back" label="Back">
      <Icon name="back" />
    </Link>
  );
}

function Navigation({ phone, section, badges, signOut }: { phone: boolean; section: Section | undefined; badges: NavigationBadges; signOut: () => void }) {
  const badgeOf = (entry: Entry): { count: number; text: string } | undefined => {
    if (entry.section === "runs" && badges.pending > 0) return { count: badges.pending, text: `${badges.pending} approval ${badges.pending === 1 ? "request waits" : "requests wait"} for an answer` };
    if (entry.section === "inbox" && badges.failedDeliveries > 0)
      return { count: badges.failedDeliveries, text: `${badges.failedDeliveries} ${badges.failedDeliveries === 1 ? "notification" : "notifications"} with a failed delivery` };
    return undefined;
  };
  return (
    <nav aria-label="Main" className={phone ? "tabs" : "rail"}>
      {!phone && (
        <Link to="/" className="rail-mark" label="Tendworks">
          <BrandMark size={34} />
        </Link>
      )}
      {ENTRIES.map((entry) => {
        const badge = badgeOf(entry);
        const describedBy = badge ? `badge-${entry.section}` : undefined;
        return (
          <Link key={entry.section} to={entry.to} current={section === entry.section} label={entry.label} describedBy={describedBy} className="nav-entry">
            <Icon name={entry.icon} />
            {phone && <span className="nav-label" aria-hidden="true">{entry.label}</span>}
            {badge && (
              <>
                <span className="badge" aria-hidden="true">
                  {badge.count}
                </span>
                <span id={describedBy} className="visually-hidden">
                  {badge.text}
                </span>
              </>
            )}
          </Link>
        );
      })}
      {!phone && (
        <button type="button" className="nav-entry rail-sign-out" aria-label="Sign out" title="Sign out" onClick={signOut}>
          <Icon name="signOut" />
        </button>
      )}
    </nav>
  );
}
