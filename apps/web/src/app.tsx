import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiProvider, checkAccess, createControlPlaneClient, type Fetch, type Scope } from "./api.js";
import { Router } from "./router.js";
import { Shell } from "./shell.js";
import { SignIn } from "./sign-in.js";
import { forgetToken, storedToken, storeToken } from "./session.js";

export interface AppProps {
  /** How the app reaches the platform: the browser's `fetch` in production. */
  fetch: Fetch;
}

type State =
  | { kind: "checking"; token: string }
  | { kind: "unreachable"; token: string }
  | { kind: "signed-out"; notice?: string }
  | { kind: "signed-in"; token: string; scope: Scope };

const NO_LONGER_ACCEPTED = "Your token is no longer accepted. Sign in again.";
const UNREACHABLE = "Cannot reach the platform. Is it running?";

/** The web UI: sign-in with an API token, then the app shell (ADR 0018). */
export function App({ fetch }: AppProps) {
  const [state, setState] = useState<State>(() => {
    const token = storedToken();
    return token === undefined ? { kind: "signed-out" } : { kind: "checking", token };
  });

  const signedOut = useCallback((notice?: string) => {
    forgetToken();
    setState(notice === undefined ? { kind: "signed-out" } : { kind: "signed-out", notice });
  }, []);

  // A token kept from earlier is checked before anything shows.
  const pending = state.kind === "checking" ? state.token : undefined;
  useEffect(() => {
    if (pending === undefined) return;
    let current = true;
    void checkAccess(pending, fetch).then((access) => {
      if (!current) return;
      if (access === "refused") signedOut(NO_LONGER_ACCEPTED);
      else if (access === "unreachable") setState({ kind: "unreachable", token: pending });
      else setState({ kind: "signed-in", token: pending, scope: access });
    });
    return () => {
      current = false;
    };
  }, [pending, fetch, signedOut]);

  const signIn = useCallback(
    async (token: string, remember: boolean) => {
      const access = await checkAccess(token, fetch);
      if (access === "refused") return "This token is not accepted. Check it and try again.";
      if (access === "unreachable") return UNREACHABLE;
      storeToken(token, { remember });
      setState({ kind: "signed-in", token, scope: access });
      return undefined;
    },
    [fetch],
  );

  const token = state.kind === "signed-in" ? state.token : undefined;
  const scope = state.kind === "signed-in" ? state.scope : undefined;
  const api = useMemo(
    () => (token === undefined || scope === undefined ? undefined : { client: createControlPlaneClient({ token, fetch, unauthorized: () => signedOut(NO_LONGER_ACCEPTED) }), scope }),
    [token, scope, fetch, signedOut],
  );

  return (
    <Router>
      {state.kind === "checking" && <p className="loading">Signing in…</p>}
      {state.kind === "unreachable" && (
        <main className="sign-in">
          <div className="panel">
            <p className="message message-error" role="alert">
              {UNREACHABLE}
            </p>
            <button type="button" className="primary" onClick={() => setState({ kind: "checking", token: state.token })}>
              Try again
            </button>
          </div>
        </main>
      )}
      {state.kind === "signed-out" && <SignIn signIn={signIn} notice={state.notice} />}
      {api && (
        <ApiProvider value={api}>
          <Shell signOut={() => signedOut()} />
        </ApiProvider>
      )}
    </Router>
  );
}
