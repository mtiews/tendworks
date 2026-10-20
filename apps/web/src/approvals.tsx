import type { ControlPlane } from "@tendworks/shared";
import { useCallback, useState } from "react";
import { useApi } from "./api.js";
import { answer } from "./answers.js";
import { Confirmation } from "./confirm.js";
import { Pending } from "./pending.js";
import { Link } from "./router.js";
import { Time } from "./time.js";
import { usePolling } from "./use-polling.js";

export type ApprovalRequest = ControlPlane.components["schemas"]["approvalRequest"];
type Decision = ControlPlane.components["schemas"]["approvalDecision"];

export type Outcome = { decided: ApprovalRequest } | { error: string };

const LABELS: Record<Decision, string> = { approve: "Approve", reject: "Reject" };

/** Pending requests first, each group newest first as the API lists them. */
const pendingFirst = (requests: ApprovalRequest[]) => [
  ...requests.filter((request) => request.status === "pending"),
  ...requests.filter((request) => request.status !== "pending"),
];

/** How long before `now` (ms, e.g. when the list was read) `value` was, in the largest whole unit; the exact time stays on hover and in `dateTime`. */
export function Age({ value, now }: { value: string; now: number }) {
  const minutes = Math.max(0, Math.floor((now - new Date(value).getTime()) / 60_000));
  const age =
    minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / (24 * 60))} days ago`;
  return (
    <time dateTime={value} title={new Date(value).toLocaleString()}>
      {age}
    </time>
  );
}

/** The approval requests (`tend approval list`): pending first, then decided ones with their decision (spec #38). */
export function ApprovalRequestsPage() {
  const { client, canChange } = useApi();
  const requests = usePolling(
    useCallback(async () => ({ items: pendingFirst((await answer(client.GET("/approval-requests"))).items), readAt: Date.now() }), [client]),
  );
  const { failure, decided } = useDecision(requests.refresh);
  const list = requests.data;

  return (
    <>
      <h1>Approval requests</h1>
      <DecisionFailure failure={failure} />
      {list === undefined ? (
        <Pending error={requests.error} what="approval requests" />
      ) : list.items.length === 0 ? (
        <p className="muted">No approval requests yet.</p>
      ) : (
        <table aria-label="Approval requests">
          <thead>
            <tr>
              <th>Status</th>
              <th>Question</th>
              <th>Run</th>
              <th>Requested</th>
              <th>Decided</th>
              {canChange && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {list.items.map((request) => (
              <tr key={request.id}>
                <td>
                  <span className={`status status-${request.status}`}>{request.status}</span>
                </td>
                <td>
                  {request.question}
                  <div className="muted">
                    {request.action} · {request.policy}
                  </div>
                </td>
                <td>
                  <Link to={`/runs/${encodeURIComponent(request.runId)}`}>{request.runId}</Link>
                </td>
                <td>
                  <Age value={request.createdAt} now={list.readAt} />
                </td>
                <td>{request.decidedAt && <Time value={request.decidedAt} />}</td>
                {canChange && (
                  <td>
                    {request.status === "pending" && <DecisionActions request={request} onDone={decided} />}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/**
 * Approve and reject for a pending request, each only after a confirmation that repeats the
 * question. `onDone` follows with the decided request, or with why the platform refused the
 * decision (e.g. decided the other way elsewhere meanwhile); either way the request changed or is stale.
 */
export function DecisionActions({ request, onDone }: { request: ApprovalRequest; onDone: (outcome: Outcome) => void }) {
  const { client } = useApi();
  const [confirming, setConfirming] = useState<Decision>();
  const [busy, setBusy] = useState(false);

  const decide = (decision: Decision) => {
    setBusy(true);
    answer(client.POST("/approval-requests/{approvalRequestId}/decision", { params: { path: { approvalRequestId: request.id } }, body: { decision } })).then(
      (decided) => done({ decided }),
      (failure: Error) => done({ error: failure.message }),
    );
  };
  const done = (outcome: Outcome) => {
    setBusy(false);
    setConfirming(undefined);
    onDone(outcome);
  };

  return (
    <div className="decision">
      <div className="decision-actions">
        {(["approve", "reject"] as const).map((decision) => (
          <button key={decision} type="button" aria-expanded={confirming === decision} disabled={busy} onClick={() => setConfirming(decision)}>
            {LABELS[decision]}
          </button>
        ))}
      </div>
      {confirming && (
        <Confirmation
          key={confirming}
          title={`${LABELS[confirming]} this request?`}
          confirmLabel={LABELS[confirming]}
          busy={busy}
          onConfirm={() => decide(confirming)}
          onCancel={() => setConfirming(undefined)}
        >
          <p>{request.question}</p>
        </Confirmation>
      )}
    </div>
  );
}

/**
 * The latest outcome of {@link DecisionActions} (`decided`, to pass as its `onDone`), and why it
 * was refused if it was; each outcome refreshes the polled requests.
 */
export function useDecision(refresh: () => void) {
  const [outcome, setOutcome] = useState<Outcome>();
  const decided = useCallback(
    (next: Outcome) => {
      setOutcome(next);
      refresh();
    },
    [refresh],
  );
  return { outcome, failure: outcome && "error" in outcome ? outcome.error : undefined, decided };
}

/** Why a decision was refused, as an alert. */
export function DecisionFailure({ failure }: { failure: string | undefined }) {
  return failure === undefined ? null : (
    <p className="message message-error" role="alert">
      {failure}
    </p>
  );
}
