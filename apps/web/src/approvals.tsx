import type { ControlPlane } from "@tendworks/shared";
import { useCallback, useState } from "react";
import { useApi } from "./api.js";
import { answer } from "./answers.js";
import { Confirmation } from "./confirm.js";
import { InboxTabs } from "./inbox-tabs.js";
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


/** The decided approval requests (pending ones are answered in the workbench and on the overview): the question, the answer and when it was decided. */
export function ApprovalRequestsPage() {
  const { client } = useApi();
  const requests = usePolling(
    useCallback(async () => (await answer(client.GET("/approval-requests", { params: { query: { status: "decided" } } }))).items, [client]),
  );

  return (
    <>
      <InboxTabs current="/approval-requests" />
      {requests.data === undefined ? (
        <Pending error={requests.error} what="approval requests" />
      ) : requests.data.length === 0 ? (
        <p className="muted">No decided approval requests yet.</p>
      ) : (
        <ul className="cards" aria-label="Approval requests">
          {requests.data.map((request) => (
            <li key={request.id} className="card">
              <div className="card-head">
                <span className={`answer answer-${outcomeOf(request) ?? "unknown"}`}>{request.answer}</span>
                {request.decidedAt && <Time value={request.decidedAt} />}
              </div>
              <div className="card-title">
                <Question request={request} />
              </div>
              <div>
                <Link to={`/runs/${encodeURIComponent(request.runId)}`} className="mono-id">Run {request.runId}</Link>
              </div>
            </li>
          ))}
        </ul>
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
