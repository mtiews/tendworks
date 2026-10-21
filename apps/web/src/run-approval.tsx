import { useCallback, useId } from "react";
import { useApi } from "./api.js";
import { answer } from "./answers.js";
import { Age, DecisionActions, DecisionFailure, useDecision } from "./approvals.js";
import { LinkedText } from "./linked-text.js";
import { usePolling } from "./use-polling.js";

/**
 * The run's pending approval request on its run detail, with approve and reject as on the
 * approval requests page (spec #38); nothing while the run waits for none. Read-only access
 * shows the request without actions.
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

  return (
    <>
      <DecisionFailure failure={failure} />
      {outcome && "decided" in outcome && (
        <p className="message" role="status">
          Approval request {outcome.decided.status}. The run continues.
        </p>
      )}
      {loaded?.request && (
        <section className="approval panel" aria-labelledby={headingId}>
          <h2 id={headingId}>Approval request</h2>
          <p>
            <LinkedText text={loaded.request.question} />
          </p>
          <p className="muted">
            {loaded.request.action} · {loaded.request.policy} · requested <Age value={loaded.request.createdAt} now={loaded.readAt} />
          </p>
          {canChange && <DecisionActions key={loaded.request.id} request={loaded.request} onDone={decided} />}
        </section>
      )}
    </>
  );
}
