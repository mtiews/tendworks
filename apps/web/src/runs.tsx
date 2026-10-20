import { useCallback } from "react";
import { useApi } from "./api.js";
import { answer } from "./answers.js";
import { formatOrigin } from "@tendworks/platform";
import { Pending } from "./pending.js";
import { Link } from "./router.js";
import { Time } from "./time.js";
import { usePolling } from "./use-polling.js";

/** Recent and active runs, newest first, refreshed by polling (`tend run list`). */
export function RunList() {
  const { client } = useApi();
  const { data, error } = usePolling(useCallback(() => answer(client.GET("/runs")), [client]));

  return (
    <>
      <h1>Runs</h1>
      {data === undefined && <Pending error={error} what="runs" />}
      {data !== undefined && error instanceof Error && (
        <p className="message message-error" role="alert">
          {error.message}
        </p>
      )}
      {data && data.items.length === 0 && <p className="muted">No runs yet.</p>}
      {data && data.items.length > 0 && (
        <table aria-label="Runs">
          <thead>
            <tr>
              <th>Run</th>
              <th>Workflow</th>
              <th>Status</th>
              <th>Started by</th>
              <th>Created</th>
              <th>Finished</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((run) => (
              <tr key={run.id}>
                <td>
                  <Link to={`/runs/${encodeURIComponent(run.id)}`}>{run.id}</Link>
                </td>
                <td>{run.workflow}</td>
                <td>
                  <span className={`status status-${run.status}`}>{run.status}</span>
                </td>
                <td>{formatOrigin(run.startedBy)}</td>
                <td>
                  <Time value={run.createdAt} />
                </td>
                <td>{run.finishedAt && <Time value={run.finishedAt} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
