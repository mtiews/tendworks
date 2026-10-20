/** Before a list's first answer: loading, or why it cannot be shown (`what`: e.g. "notifications"). */
export function Pending({ error, what }: { error: unknown; what: string }) {
  if (error === undefined) return <p className="muted">Loading…</p>;
  return (
    <p className="message message-error" role="alert">
      Cannot read the {what}. Is the platform running?
    </p>
  );
}
