# WhatsApp integration

Only the official **WhatsApp Business Platform Cloud API** is used. No unofficial libraries.

> **Verification status.** The Meta developer documentation could not be reached from the environment where this was built, so the request/response shapes in `src/lib/whatsapp/cloud.ts` and `inbound.ts` were written from Meta's published Cloud API reference as known at build time and are covered by mock-based tests only. **Before go-live, work through the Verification checklist below against the current official docs and a sandbox number.** Nothing here hard-codes pricing, category rules or template approval assumptions.

## Components

| Piece              | File                                 | Notes                                                                                                             |
| ------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Provider interface | `whatsapp/provider.ts`               | `sendText`, `sendButtons`, `sendList`, `sendTemplate`; `verifySignature`                                          |
| Mock provider      | `whatsapp/mock.ts`                   | records messages; `failNext(n, retryable)` simulates outages. Default (`WHATSAPP_PROVIDER=mock`): nothing is sent |
| Cloud API provider | `whatsapp/cloud.ts`                  | `POST https://graph.facebook.com/{version}/{phone-number-id}/messages`, Bearer token from server env only         |
| Webhook parser     | `whatsapp/inbound.ts`                | defensive: unknown shapes ignored                                                                                 |
| Webhook endpoint   | `app/api/webhooks/whatsapp/route.ts` | GET handshake, POST deliveries                                                                                    |
| Webhook service    | `services/whatsapp-webhook.ts`       | signature, idempotent inbox, status tracking, contact mapping                                                     |
| Conversation       | `services/whatsapp-conversation.ts`  | booking state machine, opt-out, hand-off                                                                          |
| Outbox             | `services/outbox.ts`                 | templates vs free text, window, retries, dead-letter                                                              |
| Text catalogue     | `whatsapp/messages.ts`               | plain-text fallbacks and mock/test content                                                                        |

## Webhook handling

1. **Handshake** `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`: returns the challenge as `text/plain` only if the token equals `WHATSAPP_VERIFY_TOKEN`.
2. **Deliveries** `POST`: the raw body is verified with HMAC-SHA256 using `WHATSAPP_APP_SECRET` against `X-Hub-Signature-256` (constant-time compare). Invalid → 403, nothing stored.
3. Each message/status becomes a `webhook_events` row with key `msg:<wamid>` or `status:<wamid>:<status>` (unique) → **duplicates are no-ops**; the inbound message id is also unique in `whatsapp_messages`, so a duplicate can never trigger a second reply (tested, including concurrent duplicates).
4. Processing retries from the table (5 attempts, then `dead`); the cron tick re-runs failures. After processing, stored event payloads are redacted (message text removed); webhook events are purged after 30 days.
5. Status events update `whatsapp_messages.status` monotonically (`sent < delivered < read`; a late `delivered` never overwrites `read`).

## Conversation design

```
Hi/menu → [Book a session] [My booking] [Talk to a person]
Book → (first time) privacy notice + [I agree][No thanks] → name → service (list)
     → masseuse (list: Any available + qualified) → day (list of days that really have slots)
     → time (list, spread across the day) → hold created → [Confirm][Cancel] → booked
No slots → [Any masseuse] [Join wait-list]
"STOP"/"unsubscribe"/"berhenti" → opt-out recorded (contact + consent); "BOOK" re-enables
"human"/"agent"/"manager" → hand-off: bot stays silent; manager replies in /manager/inbox (24 h window) or phones
```

Availability in chat comes from the same `searchSlots()`; the hold/confirm use the same `createHold`/`confirmHold` with the WhatsApp message id as idempotency key, so a retried webhook cannot double-book. If the slot is taken at the last step the customer is told and shown fresh times.

## Notifications

Scenarios (all implemented as `NotificationPurpose` + template rows): booking request received, slot held, booking confirmed, changed, cancelled, reminder, masseuse assignment (new/removed), replacement requested / nominee request / accepted / rejected, manager approval required, KPI reminder, one-time code, wait-list opening, human hand-off.

Sending rules (`services/outbox.ts`):

- Customer messages require the latest `whatsapp_messaging` consent to be granted and no opt-out (one-time codes the customer requested are exempt from the consent check, not from rate limits).
- If an **approved** template exists (`whatsapp_templates.status='approved'`) it is used with body parameters in `param_names` order. Otherwise a free-text message is allowed **only if the customer messaged in the last 24 h** (`windowHours`, configurable); outside the window the job is dead-lettered with a clear error. This is the customer-service-window awareness.
- A reminder/confirmation is skipped if the appointment is no longer in a relevant status at send time.
- Failures: retryable (network, 429, 5xx) → exponential backoff 30 s … 1 h with jitter; permanent (other 4xx) → `dead` immediately; `max_attempts` (6) exhausted → `dead`. The manager dashboard shows failed/dead counts.
- Once sent/dead/skipped, the job's personal parameters are wiped. Phone numbers are never stored in jobs (resolved at send time) and are masked in all logs (`maskPhonesInText`).

## Meta configuration (what you must do)

1. Create/choose a **Meta Business** account and **WhatsApp Business Account (WABA)**; add and verify a phone number.
2. Create a Meta app with the WhatsApp product. Note the **Phone number ID**, the **app secret**, and create a **System User permanent access token** with the `whatsapp_business_messaging` (and, for template management, `whatsapp_business_management`) permissions. Store them only in your host's secret store: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`.
3. Choose a random `WHATSAPP_VERIFY_TOKEN`.
4. Configure the webhook: callback URL `https://<your-domain>/api/webhooks/whatsapp`, the verify token, subscribe to the **messages** field.
5. Create the **message templates** in WhatsApp Manager using the names/bodies in Admin → WhatsApp templates (seeded as `<purpose>_v1`, language `en`, category per row). Meta reviews templates; record the outcome in the Templates page (status `approved`). Template wording, category and review rules are Meta's: confirm current rules in their documentation. `{{n}}` placeholders map to `param_names` in order.
6. Set `WHATSAPP_PROVIDER=cloud`.
7. Complete Meta's business verification / display-name steps as required for your volume.

### Seeded templates (parameters in order)

| purpose                                                                                      | params                                       |
| -------------------------------------------------------------------------------------------- | -------------------------------------------- |
| booking_confirmed / appointment_reminder                                                     | customer, service, staff, date, time, branch |
| booking_changed                                                                              | customer, service, staff, date, time         |
| booking_cancelled                                                                            | customer, date, time                         |
| booking_request_received                                                                     | customer, service, date, time                |
| slot_held                                                                                    | customer, date, time                         |
| assignment_new                                                                               | service, date, time                          |
| assignment_removed / replacement_accepted / replacement_rejected / manager_approval_required | date, time                                   |
| replacement_requested / replacement_nominee_request                                          | service, date, time                          |
| kpi_reminder                                                                                 | name, period, done, target, remaining        |
| customer_otp                                                                                 | code                                         |
| waitlist_available                                                                           | customer, date, time                         |
| human_handoff                                                                                | customer                                     |

## Verification checklist (do before production)

- [ ] Confirm the webhook payload shape for text, interactive `button_reply`/`list_reply` and `statuses` against Meta's current reference (parser: `inbound.ts`).
- [ ] Confirm the send payloads for text, interactive button (≤3 buttons, ≤20-char titles), interactive list (≤10 rows, 24-char titles) and template messages (positional body parameters) (`cloud.ts`).
- [ ] Confirm the current Graph API version (`WHATSAPP_GRAPH_VERSION`).
- [ ] Confirm signature verification header and algorithm (`X-Hub-Signature-256`, HMAC-SHA256 of the raw body with the app secret).
- [ ] Confirm the customer-service window length and template category rules; adjust `whatsapp.windowHours` and the template categories if they differ.
- [ ] Send each template to a test number; confirm parameters render correctly.
- [ ] Confirm opt-out expectations (STOP keyword handling) and your obligations for opt-in evidence (`customer_consents`).
- [ ] Review Meta pricing/conversation categories for your expected volume (not encoded anywhere in this system).
- [ ] Run a failure drill: revoke the token, confirm jobs dead-letter and the dashboard alerts.

## Local development without WhatsApp

`WHATSAPP_PROVIDER=mock` (default). To simulate an inbound message, POST a signed payload to `/api/webhooks/whatsapp` (see `tests/whatsapp.integration.test.ts` for the signing helper) or use the test suite, which drives the whole conversation through the mock.
