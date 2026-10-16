# Architecture

## Principles

1. **PostgreSQL is the single source of truth.** WhatsApp, the web UI and any export are _views_ of it. Nothing else holds a schedule.
2. **The database refuses invalid states**, not just the application: overlaps, status changes, qualification, hours, leave, audit tampering.
3. **One booking engine** (`src/lib/services/booking.ts`) serves the public site, WhatsApp, the manager and masseuses.
4. **Business rules live in `src/lib/domain` and `src/lib/services`**, never in UI components. Route handlers only authenticate, validate (Zod) and call services.
5. **Least privilege** at three layers: permission matrix (`domain/rbac.ts`), per-route checks, and PostgreSQL row-level security.

## Diagram

```
 Customer PWA (/book, /manage/:token, /my-bookings)        WhatsApp user
        │ HTTPS (no account)                                     │ Meta Cloud API
        ▼                                                        ▼
 ┌──────────────────────── Next.js 16 (App Router, serverless) ───────────────────────┐
 │ security headers · Origin check (CSRF) · rate limits · Zod validation              │
 │                                                                                    │
 │  /api/public/*  ─┐                       /api/webhooks/whatsapp                     │
 │  /api/* (staff) ─┼─► services/booking ◄── HMAC verify → webhook_events (idempotent)│
 │  server pages   ─┘   availability · allocation · replacement · kpi · reports       │
 │                      privacy · outbox · whatsapp-conversation · jobs               │
 │                                                                                    │
 │  /api/cron/tick (Bearer secret): expire holds · retry events · send outbox ·       │
 │                                  expire replacements · KPI reminders · retention   │
 └──────────────┬─────────────────────────────────────────────────────────────────────┘
                │ one transaction per operation:
                │   SET LOCAL ROLE booking_system | booking_staff
                │   set_config(app.org_id, app.user_id, app.staff_id, app.roles, app.actor)
                ▼
 ┌────────────────────────── PostgreSQL (Supabase-compatible) ────────────────────────┐
 │ EXCLUDE gist (staff_id =, occupied &&)  EXCLUDE gist (room_id =, occupied &&)      │
 │ triggers: status machine · immutability · qualification · hours · leave · history  │
 │ audit_row() on key tables → append-only audit_logs (row-level, actor + reason)     │
 │ RLS policies per role · column privileges (no password_hash for staff role)        │
 │ outbox: notification_jobs · webhook_events · idempotency_keys · rate_limits        │
 └────────────────────────────────────────────────────────────────────────────────────┘
   WhatsAppProvider interface ◄── MockWhatsAppProvider (dev/tests) | CloudApiProvider
```

## Layers and responsibilities

| Layer       | Files                                                                | Notes                                                                                                                                                     |
| ----------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure domain | `src/lib/domain/*`                                                   | availability maths, fair allocation, KPI formulas, status machine, phone/time helpers, RBAC matrix. No I/O, fully unit-tested.                            |
| Services    | `src/lib/services/*`                                                 | Transactions, authorisation, orchestration. Every write is in one DB transaction.                                                                         |
| DB access   | `src/lib/db/*`                                                       | `withTx(ctx, fn)` sets the DB role and request context, retries serialization failures/deadlocks, maps Postgres errors (`23P01`, `BK001…`) to `AppError`. |
| HTTP        | `src/lib/http/*`, `src/app/api/*`                                    | `route()` wrapper: same-origin check, session, permission, rate limit, Zod, structured errors with a request id.                                          |
| UI          | `src/app/*`, `src/components/*`                                      | Server components fetch via services under the caller's RLS context; client components call the API.                                                      |
| WhatsApp    | `src/lib/whatsapp/*`, `services/whatsapp-*.ts`, `services/outbox.ts` | Provider abstraction, parser, signature check, conversation state machine, outbox worker.                                                                 |

## Database roles and context

- `booking_staff`: RLS-enforced, used for **reads of schedules and dashboards** so a masseuse's query physically cannot return other people's rows.
- `booking_system`: used by the **booking engine and public/webhook flows** after the code has authorised the caller. It must see all bookings (availability) but is limited to one organisation.
- The connection user (Supabase `postgres`, or your owner role) must be a member of both roles (the migration grants this) and **not** be used for requests directly.
- This is a deliberate trust boundary: the application server is trusted to authorise before using `booking_system`; RLS on `booking_staff` is defence in depth for read paths and for any future code that uses it for writes. A compromised server can still use the system role; protect it with secrets management and least-privilege deployment (see privacy-security-checklist.md).

## Booking flow (customer)

1. `GET /api/public/availability` → `searchSlots()` → pure `computeSlots()` over data loaded for the branch/service/staff.
2. `POST /api/public/holds` → in **one transaction**: release expired holds, idempotency check, validate service/notice/advance, rank staff (fair allocation if "any"), for each candidate insert `appointments(status='slot_held')` + `appointment_assignments(active)`; the exclusion constraint and triggers decide; first success wins; `slot_holds` row stores `sha256(token)`.
3. `POST /api/public/bookings` → lock the hold, verify not expired, upsert customer (no overwrite of existing records from unauthenticated input), record consents, `slot_held → confirmed`, enqueue notifications in the **same transaction** (transactional outbox).
4. Cron tick/outbox worker sends WhatsApp templates; failures retry with exponential backoff, then dead-letter.

The availability list is advisory. **A booking exists only if the transaction commits.**

## Conflict prevention

See `decisions/0002-conflict-prevention.md`.

## Status machine

`draft → slot_held → pending_confirmation → confirmed → checked_in → in_progress → completed`, plus `no_show`, `cancelled_by_customer`, `cancelled_by_business`, `replacement_pending`, `rescheduled`, `expired`. The allowed transitions are a table in the database (`appointment_status_transitions`) enforced by trigger `BK005`, mirrored in `domain/status.ts`; a test asserts they are identical. Time, service, room and customer of an appointment are immutable (`BK006`): rescheduling creates a new appointment and marks the old one `rescheduled`.

## Replacement workflow

`requestReplacement → (nominee) respondAsNominee → (manager) decideAsManager → commit`.

- The original assignment stays **authoritative and active** while the request is open; the appointment is flagged `replacement_pending`.
- Eligibility of the nominee is checked with a **dry run of the real database rules** (the swap is executed inside a savepoint that is always rolled back), at request time, at acceptance, and again at commit.
- At commit the old assignment becomes `superseded` (never deleted) and a new `active` assignment with `origin='replacement'` is created. If the database refuses (nominee became unavailable), the request is marked `failed` and the original assignment remains.
- No self-approval: the approver may not be the requester or the nominee (matters when a manager also works as a masseuse).
- KPI credit goes only to the active assignment of a _completed_ appointment (`kpi.ts: loadWorkRecords`), so hours can never be credited twice.

## KPI and reporting

Formulas are pure functions in `domain/kpi.ts` with an `explanation` string showing the actual inputs; the UI displays "how it is calculated". Targets are rows (`staff_kpi_targets`) with validity dates; a personal target overrides the default. Metrics come from _completed_ appointments unless the metric is explicitly about scheduled/cancelled/no-show hours.

## Notifications and WhatsApp

See `whatsapp-integration.md`.

## Observability

Structured JSON logs (`src/lib/log.ts`) with phone numbers masked in every message and field; each API error carries a `requestId` also written to `audit_logs.request_id`. Dashboards surface failed/dead notifications and waiting WhatsApp hand-offs.

## Comparison with alternatives

### A. Azure SQL Database serverless + Azure Functions

Viable and conventional for an Azure/Microsoft shop. Differences that matter here:

- **Overlap prevention**: SQL Server has no range type or exclusion constraint. You would enforce non-overlap with `sp_getapplock`/`UPDLOCK, HOLDLOCK` range locks or `SERIALIZABLE` inside stored procedures, plus an indexed "slot grid" table with a unique key per (staff, 15-minute slot) as a constraint-based fallback. It works, but the guarantee lives in procedure discipline rather than a declarative constraint.
- **RLS**: supported (security policies). **Realtime** would need SignalR/Event Grid; Supabase provides it.
- **Auth**: Entra External ID / B2C is more complex than Supabase Auth; for staff-only logins either works.
- **Ops**: serverless auto-pause cold starts matter for a booking site. Functions need their own deployment pipeline.
- **Verdict**: sound alternative if the organisation is already on Azure; more code for the same guarantees.

### B. Google Sheets + Apps Script

Suitable for a _view/export_, not for the source of truth.

- **No transactions or constraints.** A sheet cannot declare "no two rows may overlap for the same staff". Apps Script `LockService` serialises scripts but only those that choose to take the lock: a manual edit, an import, another script, or a lock timeout bypasses it.
- **Race windows.** Read-then-append is exactly the unsafe sequence the brief warns about. Two web requests, a WhatsApp message and a manager's manual edit can interleave; there is no atomic "insert unless overlaps".
- **No row-level security**: sharing a sheet shares all of it, including customer phone numbers; the audit trail is edit history, not an append-only log with actor and reason.
- **Quotas and latency**: Apps Script has execution time and daily quotas; the web app endpoint adds seconds of latency; sheets degrade with size.
- **Idempotency, retries, webhooks** all have to be hand-built.
- **Verdict**: use it only as an _export_ generated from PostgreSQL (e.g. the manager's familiar weekly view). Never let it accept writes.

See `cost-comparison.md` for cost drivers.

## Extensibility (phase two)

Payments, packages, loyalty and commissions attach to `appointments` through new tables referencing `appointments.id` and `services.id`; no change to the booking engine is needed (`price_myr` is already snapshotted on the appointment). `resources` exists for equipment constraints (mirror of rooms). New booking channels add a `source` value and call the same service functions.
