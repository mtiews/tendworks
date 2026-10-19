import type { ControlPlane } from "@tendworks/shared";

export type Notification = ControlPlane.components["schemas"]["notification"];

/** Port to human interaction, which owns notifications. The control plane keeps none. */
export interface NotificationsPort {
  /** Notifications, newest first. */
  list(): Promise<Notification[]>;
}
