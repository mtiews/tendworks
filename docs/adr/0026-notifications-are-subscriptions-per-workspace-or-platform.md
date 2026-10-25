# Notifications are subscriptions per workspace or for the platform

Notifications separate three things:

- **The event catalog belongs to the platform.**
  - Per workspace: `run.started`, `run.completed`, `run.failed`, `approval.requested`.
  - For the platform: `platform.degraded`, `platform.recovered`.
  - Runs without a workspace belong to the platform scope: a platform subscription may also select the four run events, which then concern those runs only.
- **A notification channel is how someone is reached:** an adapter (`pushover`, `fake`) with its credentials and a default priority. It selects no events.
- **A subscription chooses** events of one scope (a workspace, or the platform) and sends them to channels, optionally with a priority.

A workspace is a project. Its subscriptions live next to its workspace and trigger bindings in the configuration and apply to everyone working on it: the project's failures and approvals concern all of them. The platform scope is opt-in. Whoever wants to know whether the platform itself runs subscribes to it, like to a service's status page.

Every notifiable event appears in the notification list. Only subscribed ones are delivered: once per channel, with the highest priority of the matching subscriptions, with the delivery status recorded per channel. Subscriptions address channels until the platform knows people; then they address the workspace's members, with scope and events unchanged.

The control plane, which owns `/status`, checks the platform's components periodically. After two equal results in a row it publishes `platform.health-changed`, which human interaction turns into `platform.degraded` or `platform.recovered`. A platform that is down cannot report itself, so the server also pings an external monitor at `TEND_HEARTBEAT_URL` while it is healthy; the monitor alarms when the ping stops.

## Considered Options

- **Event selection on the channel** (ADR 0025): one installation-wide choice for every project, mixing delivery with interest.
- **Subscriptions per person only:** every member configures the project's essentials again; projects lose their shared rules.
- **A separate operator level for platform events:** an extra concept for what is just another scope.
- **Platform self-reporting only:** silent in the most important case, a platform that is down.

## Consequences

- One new kind (`Subscription`); `NotificationChannel` loses its `events`.
- Platform health becomes an event that later clients (a status page, other channels) can build on.
- The heartbeat needs an external service the operator chooses; without it, a dead platform stays silent.
- This extends ADR 0025.
