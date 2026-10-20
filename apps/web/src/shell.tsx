import { useEffect } from "react";
import { useApi } from "./api.js";
import { resolve, routes } from "./routes.js";
import { Link, useLocation } from "./router.js";

/** The signed-in app: navigation, the access scope, sign-out, and the current view. */
export function Shell({ signOut }: { signOut: () => void }) {
  const { client, scope } = useApi();
  const { path } = useLocation();
  const found = resolve(path);

  useEffect(() => {
    document.title = `${found?.route.title ?? "Not found"} · Tendworks`;
  }, [found?.route.title]);

  // Each navigation asks again what the token may do, so a token that is no longer accepted
  // sends the operator back to sign-in (the client's 401 handler) even on a view that reads nothing.
  useEffect(() => {
    void client.GET("/access").catch(() => undefined);
  }, [client, path]);

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
        <span className={`scope scope-${scope}`} title={scope === "read" ? "Signed in with the read-only token: the UI only shows." : "Signed in with the API token."}>
          {scope === "read" ? "Read-only" : "Full access"}
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
