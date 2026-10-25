import type { ControlPlane } from "@tendworks/shared";
import { useCallback } from "react";
import { answer } from "./answers.js";
import { useApi } from "./api.js";
import { usePolling, type Polled } from "./use-polling.js";

export type PlatformStatus = ControlPlane.components["schemas"]["PlatformStatus"];

/** The platform's health (`GET /status`), refreshed by polling. 503 carries the same document as 200: an unhealthy platform is an answer, not a failure. */
export function usePlatformStatus(): Polled<PlatformStatus> {
  const { client } = useApi();
  return usePolling(
    useCallback(
      () => answer<PlatformStatus>(client.GET("/status").then((result) => (result.error !== undefined && result.response.status === 503 ? { data: result.error, response: result.response } : result))),
      [client],
    ),
  );
}

/** The components that are not healthy. */
export const unhealthyComponents = (status: PlatformStatus) => status.components.filter((component) => component.status !== "healthy");
