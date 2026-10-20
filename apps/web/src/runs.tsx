import { useApi } from "./api.js";
import { answer } from "./answers.js";
import { formatOrigin } from "./format.js";
import { Link } from "./router.js";
import { usePolling } from "./use-polling.js";

/** Recent and active runs, newest first, refreshed by polling (`tend run list`). */
export function RunList() {
  const { client } = useApi();
  const { data, error, loading } = usePolling(() => answer(client.GET("/runs")));

  return (
    <>
      <h1>Runs</h1>
      {error && (
        <p className="message message-error" role="alert">
          {error.message}
        </p>
      )}
      {loading && <p className="muted">Loading…</p>}
      {data && data.items.length === 0 && <p className="muted">No runs yet.</p>}
      {data && data.items.length > 0 && (
        <div className="table-scroll">
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
                    <time dateTime={run.createdAt}>{run.createdAt}</time>
                  </td>
                  <td>{run.finishedAt && <time dateTime={run.finishedAt}>{run.finishedAt}</time>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
