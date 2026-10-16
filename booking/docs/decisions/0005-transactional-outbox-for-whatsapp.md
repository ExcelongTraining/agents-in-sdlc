# ADR-0005: Transactional outbox, idempotent webhook inbox

- Status: accepted
- Decision: business transactions insert `notification_jobs` rows (unique `dedupe_key`) in the _same_ transaction as the change; a worker (`processDueNotifications`, run by the cron tick) delivers them with leases (`FOR UPDATE SKIP LOCKED`), exponential backoff (30 s … 1 h, jitter), `dead` status after `max_attempts` or a permanent provider error. Personal parameters are wiped from a job once it is sent/dead/skipped.
- Inbound: every webhook event is inserted into `webhook_events` with a unique `(provider, event_key)`; duplicates are no-ops; processing is retried from the table (5 attempts then `dead`). Replies are sent after the processing transaction commits.
- Why: the database transaction and the WhatsApp API cannot be atomic; this ensures a rolled-back booking never notifies and a committed booking never loses its notification.
