import { useCallback } from "react";
import { answer } from "./answers.js";
import { useApi } from "./api.js";
import { InboxTabs } from "./inbox-tabs.js";
import { Pending } from "./pending.js";
import { Chip, StatePill } from "./pill.js";
import { usePolling } from "./use-polling.js";

/** Who gets what: the configured subscriptions, read-only (ADR 0026). They change in the configuration repository. */
export function SubscriptionsPage() {
  const { client } = useApi();
  const subscriptions = usePolling(
    useCallback(async () => (await answer(client.GET("/subscriptions"))).items, [client]),
  );

  return (
    <>
      <InboxTabs current="/subscriptions" />
      {subscriptions.data === undefined ? (
        <Pending error={subscriptions.error} what="subscriptions" />
      ) : subscriptions.data.length === 0 ? (
        <p className="muted">No subscriptions: notifications are listed, but delivered nowhere.</p>
      ) : (
        <ul className="cards" aria-label="Subscriptions">
          {subscriptions.data.map((subscription) => (
            <li key={subscription.name} className="card">
              <div className="card-head">
                <span className="card-kind">{subscription.name}</span>
                <Chip>{"workspace" in subscription.scope ? `workspace ${subscription.scope.workspace}` : "platform"}</Chip>
              </div>
              <dl className="facts">
                <dt>Events</dt>
                <dd className="chips">
                  {subscription.events.map((event) => (
                    <StatePill key={event} state={event} />
                  ))}
                </dd>
                <dt>Channels</dt>
                <dd>{subscription.channels.join(", ")}</dd>
                <dt>Priority</dt>
                <dd>{subscription.priority ?? <span className="muted">channel default</span>}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
