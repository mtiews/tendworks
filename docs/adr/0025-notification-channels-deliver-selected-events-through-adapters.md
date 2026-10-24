# Notification channels deliver selected events through adapters; Pushover first

Notifications are persisted first and then delivered through the notification delivery port. That port has a fake and a Pushover implementation.

Delivery is configured with the kind `NotificationChannel`:

- `integration`: `fake` or `pushover`;
- `pushover`: `token` and `user` as secret references to platform secrets, optional `priority`;
- `events`: the events this channel receives, out of `approval.requested`, `run.failed` and `run.completed`.

Each notification goes to every channel that selects its event, and its delivery status is recorded per channel. A failed delivery is visible in the notification list. Notifications of finished runs carry the run's reported artifacts; notifications of approval requests carry the request's links the same way. Pushover uses the first link as the message URL, so a tap opens it.

## Considered Options

- **ntfy:** self-hostable and simple, but the operator uses Pushover.
- **Web Push from the web UI:** needs a service worker, subscription storage and TLS on every device; later.
- **Email:** needs mail infrastructure on the host.

## Consequences

- The Pushover app token and user key are platform secrets on the server; they never reach a sandbox.
- More channels (Web Push, email, ntfy) are further adapters behind the same port, and channel kinds in the same schema.
- The product name appears only in the channel's integration selector.
- The events `run.completed` and `run.failed` carry the artifacts the run's steps reported, so human interaction takes them from the event and never reads orchestration's record of the run.
- Emergency priority (2) needs acknowledgement and retries; channels support -2 to 1 until a use case needs it.
