import { useEffect } from "react";
import { useApi } from "./api.js";
import { resolve, routes } from "./routes.js";
import { Link, useLocation } from "./router.js";

/** The signed-in app: navigation, the access scope, sign-out, and the current view. */
export function Shell({ signOut }: { signOut: () => void }) {
  const { canChange } = useApi();
  const { path } = useLocation();
  const found = resolve(path);

  useEffect(() => {
    document.title = `${found?.route.title ?? "Not found"} · Tendworks`;
  }, [found?.route.title]);

  return (
    <div className="shell">
      <header className="top-bar">
        <span className="brand">Tendworks</span>
        <nav aria-label="Main" className="main-nav">
          {routes
            .filter((route) => route.nav)
            .map((route) => (
              <Link key={route.pattern} to={route.pattern} current={found?.route.section === route.section}>
                {route.title}
              </Link>
            ))}
        </nav>
        <span className={`scope scope-${canChange ? "full" : "read"}`} title={canChange ? "Signed in with the API token." : "Signed in with the read-only token: the UI only shows."}>
          {canChange ? "Full access" : "Read-only"}
        </span>
        <button type="button" className="quiet" onClick={signOut}>
          Sign out
        </button>
      </header>
      <main className="content">
        {found ? (
          found.route.render(found.parameters)
        ) : (
          <>
            <h1>Not found</h1>
            <p className="muted">
              The UI has no page at this address. <Link to="/">Go to the status page</Link>.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
