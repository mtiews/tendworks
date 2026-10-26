import type { ControlPlane } from "@tendworks/shared";
import { useCallback } from "react";
import { answer } from "./answers.js";
import { useApi } from "./api.js";
import { InboxTabs } from "./inbox-tabs.js";
import { safeHref } from "./markdown.js";
import { Pending } from "./pending.js";
import { StatePill } from "./pill.js";
import { Link } from "./router.js";
import { Age } from "./time.js";
import { usePolling } from "./use-polling.js";

type Notification = ControlPlane.components["schemas"]["NotificationList"]["items"][number];

/**
 * What the platform told the operator, newest first (ADR 0025): one compact row per
 * notification with its age, its event as a pill, its title, run and artifacts, and its
 * delivery per channel; a failed delivery stands out.
 */
export function NotificationsPage() {
  const { client } = useApi();
  const notifications = usePolling(useCallback(async () => ({ items: (await answer(client.GET("/notifications"))).items, readAt: Date.now() }), [client]));
  const data = notifications.data;

  return (
    <>
      <InboxTabs current="/notifications" />
      {data === undefined ? (
        <Pending error={notifications.error} what="notifications" />
      ) : data.items.length === 0 ? (
        <p className="muted">No notifications yet.</p>
      ) : (
        <div className="panel">
          <ul className="rows" aria-label="Notifications">
            {data.items.map((notification) => (
              <li key={notification.id} className="notification">
                <NotificationRow notification={notification} readAt={data.readAt} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function NotificationRow({ notification, readAt }: { notification: Notification; readAt: number }) {
  return (
    <>
      <span className="notification-age">
        <Age value={notification.createdAt} now={readAt} />
      </span>
      <span className="notification-event">
        <StatePill state={notification.kind} />
      </span>
      <span className="notification-main">
        <span className="notification-title">{notification.title}</span>{" "}
        {(notification.artifacts ?? []).map((artifact) => {
          const href = safeHref(artifact.url);
          return href ? (
            <a key={`${artifact.name} ${artifact.url}`} className="chip" href={href} target="_blank" rel="noopener noreferrer">
              {artifact.name}
            </a>
          ) : (
            <span key={`${artifact.name} ${artifact.url}`} className="chip">
              {artifact.name}
            </span>
          );
        })}
        {notification.runId ? (
          <Link to={`/runs/${encodeURIComponent(notification.runId)}`} className="mono-id">
            Run {notification.runId.slice(0, 8)}
          </Link>
        ) : (
          <span className="chip">platform</span>
        )}
        {notification.detail && (
          <span className="notification-detail muted" title={notification.detail}>
            {notification.detail}
          </span>
        )}
      </span>
      {notification.deliveries.length === 0 ? (
        <span className="notification-delivery muted">No subscription sends this notification to a channel.</span>
      ) : (
        <ul className="notification-delivery deliveries" aria-label="Deliveries">
          {notification.deliveries.map((delivery) => (
            <li key={delivery.channel} className={delivery.status === "failed" ? "state-unhealthy" : undefined} title={delivery.error}>
              {delivery.channel}: {delivery.status}
              {delivery.error ? `: ${delivery.error}` : ""}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
