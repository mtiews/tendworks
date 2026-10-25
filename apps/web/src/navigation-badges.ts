import { useCallback } from "react";
import { answer } from "./answers.js";
import { useApi } from "./api.js";
import { usePolling } from "./use-polling.js";

export interface NavigationBadges {
  /** Approval requests waiting for an answer. */
  pending: number;
  /** Notifications with at least one failed delivery. */
  failedDeliveries: number;
}

/** The numbers the navigation shows; a count the platform cannot answer is left at 0 rather than blocking the shell. */
export function useNavigationBadges(): NavigationBadges {
  const { client } = useApi();
  const pending = usePolling(
    useCallback(async () => (await answer(client.GET("/approval-requests", { params: { query: { status: "pending" } } }))).items.length, [client]),
  );
  const notifications = usePolling(
    useCallback(
      async () => (await answer(client.GET("/notifications"))).items.filter((notification) => notification.deliveries.some((delivery) => delivery.status === "failed")).length,
      [client],
    ),
  );
  return { pending: pending.data ?? 0, failedDeliveries: notifications.data ?? 0 };
}
