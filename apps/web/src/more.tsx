import { useState } from "react";
import { useApi } from "./api.js";
import { chooseStartPage, startPage, type StartPage } from "./start-page.js";

/** The sections without a place in the tabs, the start page choice, the access scope and sign-out. */
export function MorePage({ signOut, showSignOut }: { signOut: () => void; showSignOut: boolean }) {
  const { canChange } = useApi();
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
