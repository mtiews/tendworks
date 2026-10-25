import { useCallback } from "react";
import { answer } from "./answers.js";
import { Artifacts } from "./artifacts.js";
import { useApi } from "./api.js";
import { InboxTabs } from "./inbox-tabs.js";
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
      <InboxTabs current="/notifications" />
      {notifications.data === undefined ? (
        <Pending error={notifications.error} what="notifications" />
      ) : notifications.data.length === 0 ? (
        <p className="muted">No notifications yet.</p>
      ) : (
        <ul className="cards" aria-label="Notifications">
          {notifications.data.map((notification) => (
            <li key={notification.id} className="card">
              <div className="card-head">
                <span className="card-kind">{notification.kind}</span>
                <Time value={notification.createdAt} />
              </div>
              <div className="card-title">{notification.title}</div>
              {notification.detail && <div className="muted">{notification.detail}</div>}
              <Artifacts artifacts={notification.artifacts ?? []} />
              {notification.deliveries.length === 0 ? (
                <p className="muted">No subscription sends this notification to a channel.</p>
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
              <div>
                {notification.runId ? <Link to={`/runs/${encodeURIComponent(notification.runId)}`}>Run {notification.runId}</Link> : <span className="muted">platform</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
