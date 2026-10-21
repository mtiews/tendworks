import { useId, useState, type FormEvent } from "react";

export interface SignInProps {
  /** Answers why the token was not taken, or nothing when it was. */
  signIn: (token: string, remember: boolean) => Promise<string | undefined>;
  /** Why the operator is here again, e.g. a token that is no longer accepted. */
  notice?: string | undefined;
}

export function SignIn({ signIn, notice }: SignInProps) {
  const tokenId = useId();
  const rememberId = useId();
  const [token, setToken] = useState("");
  const [remember, setRemember] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Never a form submission: that would put the token into the URL.
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    void signIn(token.trim(), remember).then((refused) => {
      setBusy(false);
      setProblem(refused);
    });
  };

  const message = problem ?? notice;
  return (
    <main className="sign-in">
      <form className="panel sign-in-form" onSubmit={submit} method="post" action="#">
        <h1>Tendworks</h1>
        <p className="muted">Sign in with the platform's API token, or its read-only token to only look.</p>
        {message && (
          <p className="message message-error" role="alert">
            {message}
          </p>
        )}
        <label htmlFor={tokenId}>API token</label>
        <input
          id={tokenId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <div className="checkbox">
          <input id={rememberId} type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          <label htmlFor={rememberId}>Stay signed in on this device</label>
        </div>
        <button type="submit" className="primary" disabled={busy || token.trim() === ""}>
          Sign in
        </button>
      </form>
    </main>
  );
}
