import { useCallback } from "react";
import { useApi } from "./api.js";
import { Pending } from "./pending.js";
import { Link } from "./router.js";
import { Time } from "./time.js";
import { usePolling } from "./use-polling.js";

/** What the platform told the operator, newest first, each with its run (spec #38). */
export function NotificationsPage() {
  const { client } = useApi();
  const notifications = usePolling(
    useCallback(async () => {
      const { data, response } = await client.GET("/notifications");
      if (!data) throw new Error(`HTTP ${response.status}`);
      return data.items;
    }, [client]),
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
                  <Link to={`/runs/${encodeURIComponent(notification.runId)}`}>{notification.runId}</Link>
                </td>
                <td className={notification.delivery.status === "failed" ? "state-unhealthy" : undefined}>
                  {notification.delivery.status}
                  {notification.delivery.error ? `: ${notification.delivery.error}` : ""}
                </td>
                <td>
                  {notification.title}
                  {notification.detail && <div className="muted">{notification.detail}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
