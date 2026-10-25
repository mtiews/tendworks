import { useCallback } from "react";
import { answer } from "./answers.js";
import { useApi } from "./api.js";
import { Pending } from "./pending.js";
import { usePolling } from "./use-polling.js";

/** Who gets what: the configured subscriptions, read-only (ADR 0026). They change in the configuration repository. */
export function SubscriptionsPage() {
  const { client } = useApi();
  const subscriptions = usePolling(
    useCallback(async () => (await answer(client.GET("/subscriptions"))).items, [client]),
  );

  return (
    <>
      <h1>Subscriptions</h1>
      {subscriptions.data === undefined ? (
        <Pending error={subscriptions.error} what="subscriptions" />
      ) : subscriptions.data.length === 0 ? (
        <p className="muted">No subscriptions: notifications are listed, but delivered nowhere.</p>
      ) : (
        <table aria-label="Subscriptions">
          <thead>
            <tr>
              <th>Name</th>
              <th>Scope</th>
              <th>Events</th>
              <th>Channels</th>
              <th>Priority</th>
            </tr>
          </thead>
          <tbody>
            {subscriptions.data.map((subscription) => (
              <tr key={subscription.name}>
                <td>{subscription.name}</td>
                <td>{"workspace" in subscription.scope ? `workspace ${subscription.scope.workspace}` : "platform"}</td>
                <td>{subscription.events.join(", ")}</td>
                <td>{subscription.channels.join(", ")}</td>
                <td>{subscription.priority ?? <span className="muted">channel default</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
