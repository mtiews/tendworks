# Notification channels deliver selected events through adapters; Pushover first

Notifications are persisted first and then delivered through the notification delivery port. That port has a fake and a Pushover implementation.

Delivery is configured with the kind `NotificationChannel`:

- `integration`: `fake` or `pushover`;
- `pushover`: `token` and `user` as secret references to platform secrets;
- `priority`: optional default priority.

(ADR 0026 moved event selection from the channel to subscriptions and the priority to the channel and the subscription.) Each notification goes to every channel a matching subscription names, and its delivery status is recorded per channel. A failed delivery is visible in the notification list. Notifications of finished runs carry the run's reported artifacts, followed by the link of the item that triggered the run; notifications of started runs carry that item's link, notifications of approval requests the request's links. Pushover uses the first link as the message URL, so a tap opens it: the pull request of a completed run, else e.g. the issue. A run notification's title names status, workspace and workflow and the item (`Completed · app/develop-issue · #42 Fix login`); its detail is the whole message, one entry per line, ending with the short run id, so every channel and client shows the same text.

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
