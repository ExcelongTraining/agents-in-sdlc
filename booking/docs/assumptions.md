# Assumptions and decisions needing business input

Everything below was assumed so work could continue. Each is configurable unless noted. Please confirm or change.

## Needs your decision (business)

| #   | Question                                                        | Default used                                                                                                                                                               | Where to change                                 |
| --- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1   | Free cancellation/reschedule window for customers               | 24 h before start                                                                                                                                                          | Settings → booking → `changeCutoffHours`        |
| 2   | Minimum notice / maximum advance for online bookings            | 2 h / 60 days                                                                                                                                                              | Settings → booking                              |
| 3   | Hold time while a customer completes the form                   | 10 min                                                                                                                                                                     | Settings → booking → `holdMinutes`              |
| 4   | Do web bookings need the manager's approval?                    | No (confirmed immediately)                                                                                                                                                 | Settings → booking → `webRequiresApproval`      |
| 5   | Does a replacement need manager approval? Is the customer told? | Yes / Yes                                                                                                                                                                  | Settings → replacement                          |
| 6   | Fair-allocation rule for "any available"                        | Lowest weighted load in ±14 days, then least recently assigned; max 240 min back-to-back                                                                                   | Settings → allocation; per-staff weight in Team |
| 7   | Do consultations count towards KPI hours?                       | No: reported separately as _consultation hours_; service flag `counts_toward_kpi` is off for the demo consultation                                                         | Services                                        |
| 8   | KPI hours basis                                                 | `scheduled` duration of completed appointments (alternative: `actual` minutes recorded at completion)                                                                      | Settings → kpi                                  |
| 9   | KPI targets                                                     | 120 completed service hours/month and 30/week for everyone (demo values)                                                                                                   | KPI targets                                     |
| 10  | Are rooms a real constraint?                                    | Only services marked "needs a room"                                                                                                                                        | Services, Rooms                                 |
| 11  | Are breaks overridable by a manager?                            | Yes (with reason). Leave, blocked time, closures, qualification and double-booking are **never** overridable                                                               | Code: `assignments_validate()`                  |
| 12  | Data retention                                                  | Customers anonymised after 36 months inactive; WhatsApp text removed after 90 days; webhook events after 30 days; audit log kept 84 months (see note in backup-restore.md) | Settings → retention                            |
| 13  | Language                                                        | English only. Templates are keyed by language so Bahasa Malaysia / Mandarin can be added                                                                                   | `whatsapp_templates.language`                   |
| 14  | Branches                                                        | One branch in use; schema, services and rooms are branch-aware, UI assumes the first active branch                                                                         | —                                               |
| 15  | Who may record direct bookings                                  | Any masseuse with `can_take_direct_bookings` (default true), for herself only                                                                                              | Team → Staff settings                           |

## Technical assumptions

- **Own authentication instead of Supabase Auth** (ADR-0004): email + password (scrypt), hashed server-side sessions, rate limiting and lockout. Supabase can be used purely as managed PostgreSQL. MFA is not implemented (see Known limitations).
- **PostgreSQL 15+** with `btree_gist` (available on Supabase). Tested on PostgreSQL 16.
- **Single-organisation deployment** (`ORG_SLUG`), multi-tenant schema (every table has `organisation_id`, RLS isolates tenants).
- **Time zone** `Asia/Kuala_Lumpur` (UTC+8, no DST). All stored times are UTC; branch time zone is used for hours/day boundaries.
- **Appointments are immutable in time**: moving an appointment creates a new appointment and marks the old one `rescheduled` (history kept). Drag-and-drop in the calendar uses this.
- **Buffers**: the _service_ interval must fit working hours; the _occupied_ interval (service + buffers) must not overlap other bookings or approved leave/breaks.
- **Expired holds** are released lazily inside every booking transaction and by the cron tick; correctness never depends on cron.
- **Customers are not accounts.** Access is an appointment-scoped signed link or a WhatsApp one-time code.
- **Web bookings are not phone-verified** before confirmation; the WhatsApp confirmation to the given number and the rate limits are the mitigation (see Known limitations).
- **No staff gender or other protected characteristics are stored or used** in allocation. A customer may ask for a _named_ masseuse; they cannot filter by personal attributes.
- **Pricing** is stored and optionally displayed but no payment is taken.
- **WhatsApp**: Cloud API payload shapes were written from Meta's published reference but the developer docs were unreachable from the build sandbox, so they have **not** been verified against live documentation or a live account. See `whatsapp-integration.md` → Verification checklist.

## Missing external credentials (nothing blocks local use)

- WhatsApp Business Account, phone number id, system-user token, app secret, approved templates.
- A hosted PostgreSQL (Supabase project or other) and a deployment target.
- Real privacy notice text (draft provided) reviewed by a Malaysian privacy adviser.

## Known limitations (not hidden)

- No MFA for staff. Recommended before go-live for manager/administrator.
- No UI for the wait-list queue (entries are created and offered automatically on cancellation; view via database).
- No audit-log purge job (the table is append-only by design; see backup-restore.md).
- CSP allows `'unsafe-inline'` scripts (needed by Next.js bootstrap). A nonce-based CSP via middleware is a hardening step.
- Staff e-mail/SMS fallback when WhatsApp is down does not exist; in-app indicators and the dashboard alerts cover it.
- Login/IP rate limiting trusts `x-forwarded-for` as set by the host (Vercel sets it). Behind other proxies configure them to overwrite it.
- Dev dependency advisory: `braces` (via `eslint-config-next`) reports a ReDoS advisory. It affects lint tooling only, not the runtime; `npm audit --omit=dev` is clean.
