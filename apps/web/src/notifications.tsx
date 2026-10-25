import { useCallback } from "react";
import { answer } from "./answers.js";
import { Artifacts } from "./artifacts.js";
import { useApi } from "./api.js";
import { Pending } from "./pending.js";
import { Link } from "./router.js";
import { Time } from "./time.js";
import { usePolling } from "./use-polling.js";

/** What the platform told the operator, newest first, each with its run, its artifacts and its delivery per channel (ADR 0025). */
export function NotificationsPage() {
  const { client } = useApi();
  const notifications = usePolling(
    useCallback(async () => (await answer(client.GET("/notifications"))).items, [client]),
  );

  return (
    <>
      <h1>Notifications</h1>
      {notifications.data === undefined ? (
        <Pending error={notifications.error} what="notifications" />
      ) : notifications.data.length === 0 ? (
        <p className="muted">No notifications yet.</p>
      ) : (
        <table aria-label="Notifications">
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Run</th>
              <th>Delivery</th>
              <th>Notification</th>
            </tr>
          </thead>
          <tbody>
            {notifications.data.map((notification) => (
              <tr key={notification.id}>
                <td>
                  <Time value={notification.createdAt} />
                </td>
                <td>{notification.kind}</td>
                <td>
                  {notification.runId ? <Link to={`/runs/${encodeURIComponent(notification.runId)}`}>{notification.runId}</Link> : <span className="muted">platform</span>}
                </td>
                <td>
                  {notification.deliveries.length === 0 ? (
                    <span className="muted">no channel</span>
                  ) : (
                    <ul className="deliveries" aria-label="Deliveries">
                      {notification.deliveries.map((delivery) => (
                        <li key={delivery.channel} className={delivery.status === "failed" ? "state-unhealthy" : undefined}>
                          {delivery.channel}: {delivery.status}
                          {delivery.error ? `: ${delivery.error}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>
                  {notification.title}
                  {notification.detail && <div className="muted">{notification.detail}</div>}
                  <Artifacts artifacts={notification.artifacts ?? []} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
