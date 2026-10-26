import { useState } from "react";
import { useApi } from "./api.js";
import { usePlatformStatus } from "./platform-status.js";
import { Link } from "./router.js";
import { Pending } from "./pending.js";
import { Time } from "./time.js";
import { chooseStartPage, startPage, type StartPage } from "./start-page.js";

/** The sections without a place in the tabs, the start page choice, the access scope and sign-out. */
export function MorePage({ signOut, showSignOut }: { signOut: () => void; showSignOut: boolean }) {
  const { canChange } = useApi();
  const status = usePlatformStatus();
  const [start, setStart] = useState<StartPage>(startPage);
  const choose = (choice: StartPage) => {
    chooseStartPage(choice);
    setStart(choice);
  };

  return (
    <>
      <h1>More</h1>
      <fieldset className="section choice">
        <legend>Start page</legend>
        <label className="checkbox">
          <input type="radio" name="start-page" checked={start === "overview"} onChange={() => choose("overview")} />
          Overview
        </label>
        <label className="checkbox">
          <input type="radio" name="start-page" checked={start === "runs"} onChange={() => choose("runs")} />
          Runs
        </label>
        <p className="muted">Where the UI opens in this browser.</p>
      </fieldset>
      <nav aria-label="Configuration" className="section">
        <ul className="more-links">
          <li><Link to="/triggers">Triggers</Link></li>
          <li><Link to="/agents">Agents</Link></li>
          <li><Link to="/workspaces">Workspaces</Link></li>
          <li><Link to="/subscriptions">Subscriptions</Link></li>
        </ul>
      </nav>
      <section className="section" aria-labelledby="more-health">
        <h2 id="more-health">Platform health</h2>
        {status.data === undefined ? (
          <Pending error={status.error} what="platform health" />
        ) : (
          <>
            <p>
              <span className={`state state-${status.data.status}`}>{status.data.status === "healthy" ? "Healthy" : "Unhealthy"}</span>{" "}
              <span className="muted">
                checked <Time value={status.data.checkedAt} />
              </span>
            </p>
            <ul className="cards" aria-label="Components">
              {status.data.components.map((component) => (
                <li key={component.name} className="card">
                  <div className="card-head">
                    <span className="card-kind">{component.name}</span>
                    <span className={`state-${component.status}`}>{component.status}</span>
                  </div>
                  {component.message && <p>{component.message}</p>}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <section className="section" aria-labelledby="more-access">
        <h2 id="more-access">Access</h2>
        <p>{canChange ? "Signed in with the API token." : "Signed in with the read-only token: the UI only shows."}</p>
        {showSignOut && (
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        )}
      </section>
    </>
  );
}
