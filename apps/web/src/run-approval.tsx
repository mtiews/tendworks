import { useCallback, useId } from "react";
import { useApi } from "./api.js";
import { answer } from "./answers.js";
import { Age, DecisionActions, DecisionFailure, outcomeOf, Question, THEN, useDecision } from "./approvals.js";
import { usePolling } from "./use-polling.js";

/**
 * The run's pending approval request on its run detail, with its answers as on the approval
 * requests page; nothing while the run waits for none. Read-only access shows the request
 * without actions.
 */
export function RunApprovalRequest({ runId }: { runId: string }) {
  const { client, canChange } = useApi();
  const polled = usePolling(
    useCallback(
      async () => ({
        request: (await answer(client.GET("/approval-requests", { params: { query: { status: "pending" } } }))).items.find((request) => request.runId === runId),
        readAt: Date.now(),
      }),
      [client, runId],
    ),
  );
  const { outcome, failure, decided } = useDecision(polled.refresh);
  const headingId = useId();
  const loaded = polled.data;
  const decidedOutcome = outcome && "decided" in outcome ? outcomeOf(outcome.decided) : undefined;

  return (
    <>
      <DecisionFailure failure={failure} />
      {outcome && "decided" in outcome && (
        <p className="message" role="status">
          Answered “{outcome.decided.answer}”.{decidedOutcome && ` ${THEN[decidedOutcome]}`}
        </p>
      )}
      {loaded?.request && (
        <section className="approval panel" aria-labelledby={headingId}>
          <h2 id={headingId}>Approval request</h2>
          <div className="approval-question">
            <Question request={loaded.request} />
          </div>
          <p className="muted">
            requested <Age value={loaded.request.createdAt} now={loaded.readAt} />
          </p>
          {canChange && <DecisionActions key={loaded.request.id} request={loaded.request} onDone={decided} />}
        </section>
      )}
    </>
  );
}
