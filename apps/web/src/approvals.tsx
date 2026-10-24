import type { ControlPlane } from "@tendworks/shared";
import { useCallback, useState } from "react";
import { useApi } from "./api.js";
import { answer } from "./answers.js";
import { Confirmation } from "./confirm.js";
import { Pending } from "./pending.js";
import { LinkedText } from "./linked-text.js";
import { safeHref } from "./markdown.js";
import { Link } from "./router.js";
import { Time } from "./time.js";
import { usePolling } from "./use-polling.js";

export type ApprovalRequest = ControlPlane.components["schemas"]["approvalRequest"];
type Answer = ControlPlane.components["schemas"]["approvalAnswer"];

export type Outcome = { decided: ApprovalRequest } | { error: string };

/** What the run does after an answer with this outcome, as a sentence. */
export const THEN: Record<Answer["outcome"], string> = { continue: "The run continues.", stop: "The run stops." };

/** The outcome of the answer a decided request was decided with. */
export const outcomeOf = (request: ApprovalRequest) => request.answers.find((offered) => offered.label === request.answer)?.outcome;

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

/** The approval requests (`tend approval list`): pending first, then decided ones with their answer. */
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
                  <Question request={request} />
                </td>
                <td>
                  <Link to={`/runs/${encodeURIComponent(request.runId)}`}>{request.runId}</Link>
                </td>
                <td>
                  <Age value={request.createdAt} now={list.readAt} />
                </td>
                <td>
                  {request.answer !== undefined && (
                    <>
                      <span className={`answer answer-${outcomeOf(request) ?? "unknown"}`}>{request.answer}</span>
                      {request.decidedAt && (
                        <div className="muted">
                          <Time value={request.decidedAt} />
                        </div>
                      )}
                    </>
                  )}
                </td>
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

/** A request's question with its URLs linked, its links, and its action and policy. */
export function Question({ request }: { request: ApprovalRequest }) {
  return (
    <>
      <LinkedText text={request.question} />
      {request.links.length > 0 && (
        <ul className="approval-links" aria-label="Links">
          {request.links.map((link) => (
            <li key={link.url}>
              <a href={safeHref(link.url)} target="_blank" rel="noopener noreferrer">
                {link.title}
              </a>
            </li>
          ))}
        </ul>
      )}
      <div className="muted">{request.policy === undefined ? request.action : `${request.action} · ${request.policy}`}</div>
    </>
  );
}

/**
 * One button per answer of a pending request, each deciding only after a confirmation that
 * repeats the question and says whether the run continues or stops. `onDone` follows with the
 * decided request, or with why the platform refused the decision (e.g. answered otherwise
 * elsewhere meanwhile); either way the request changed or is stale.
 */
export function DecisionActions({ request, onDone }: { request: ApprovalRequest; onDone: (outcome: Outcome) => void }) {
  const { client } = useApi();
  const [confirming, setConfirming] = useState<Answer>();
  const [busy, setBusy] = useState(false);

  const decide = ({ label }: Answer) => {
    setBusy(true);
    answer(client.POST("/approval-requests/{approvalRequestId}/decision", { params: { path: { approvalRequestId: request.id } }, body: { answer: label } })).then(
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
        {request.answers.map((offered) => (
          <button key={offered.label} type="button" aria-expanded={confirming?.label === offered.label} disabled={busy} onClick={() => setConfirming(offered)}>
            {offered.label}
          </button>
        ))}
      </div>
      {confirming && (
        <Confirmation
          key={confirming.label}
          title={`Answer “${confirming.label}”?`}
          confirmLabel={confirming.label}
          // Answers are free labels, often "Cancel" itself; the safe choice must not look like one.
          cancelLabel="Not now"
          busy={busy}
          onConfirm={() => decide(confirming)}
          onCancel={() => setConfirming(undefined)}
        >
          <p>{request.question}</p>
          <p>{THEN[confirming.outcome]}</p>
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
