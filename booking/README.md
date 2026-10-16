# Massage-centre booking & workforce scheduling (PWA)

A mobile-first Progressive Web App for a massage and consultation centre in Malaysia. **PostgreSQL is the single source of truth**: web, WhatsApp, telephone, walk-in and masseuse-recorded bookings all go through one engine that makes double-booking impossible at the database level, notifies people through WhatsApp, supports controlled replacements, and calculates completed hours and KPI progress with an audit trail.

> **Status: MVP implemented and tested locally; not yet production-hardened for your business.** The automated suite passes (see below), but the items in [`docs/assumptions.md`](docs/assumptions.md) → _Needs your decision_ and _Known limitations_, the WhatsApp verification checklist, and the privacy/legal review are open. Please do not treat it as production-ready until those are closed. The code lives in this `booking/` directory of the `agents-in-sdlc` repository; nothing else in the repository was changed.

## Quick start

```bash
cd booking
cp .env.example .env.local      # set DATABASE_URL (PostgreSQL 15+)
npm ci
npm run db:reset                # migrate + seed FICTIONAL demo data (refuses in production)
npm run dev                     # http://localhost:3000
```

Demo logins (password `Demo-Password-2026!`): `manager@lotus-demo.example`, `aisyah@lotus-demo.example` (masseuse; also meiling, priya, farah, lakshmi), `admin@lotus-demo.example`. Customers need no account: `/book`.

WhatsApp defaults to a **mock provider** that sends nothing.

## What is in the box

| Area           | Highlights                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Booking engine | availability with buffers/rooms/leave/hours/notice, slot holds, atomic confirm, direct bookings, reschedule, cancel, wait-list, fair "any available" allocation, idempotency             |
| Database       | exclusion constraints, status-machine trigger, immutability, qualification/hours/leave triggers, RLS (two DB roles), append-only audit, transactional outbox                             |
| Roles          | customer (link / WhatsApp code), masseuse, manager, administrator (no customer access)                                                                                                   |
| Replacement    | request → nominee → manager approval → atomic swap; history kept; no double KPI credit; no self-approval                                                                                 |
| KPI            | explainable formulas, configurable targets, progress/pace, utilisation, first-time vs returning, reports                                                                                 |
| WhatsApp       | official Cloud API provider + mock, signed idempotent webhook, booking conversation, templates table, 24 h window awareness, retries/dead-letter, opt-out, human hand-off                |
| UI             | customer wizard, manager dashboard + master calendar (drag & drop), masseuse schedule, availability, replacements, KPIs, admin audit/templates; WCAG 2.2 AA target with automated checks |
| Privacy        | consents, opt-out, export, anonymisation, retention job, masked logs                                                                                                                     |

## Commands

|                                                               |                                                                                                      |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `npm run dev / build / start`                                 | Next.js                                                                                              |
| `npm run typecheck` · `npm run lint` · `npm run format:check` | static checks                                                                                        |
| `npm test`                                                    | 130+ unit & integration tests against a real PostgreSQL (needs `TEST_DATABASE_ADMIN_URL`)            |
| `npm run test:e2e`                                            | Playwright, mobile viewport, with axe accessibility checks (`npx playwright install chromium` first) |
| `npm run db:migrate` · `db:seed` · `db:reset`                 | migrations (forward-only SQL in `supabase/migrations`) and demo seed                                 |

## Documentation

|                                                                          |                                                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| [docs/product-requirements.md](docs/product-requirements.md)             | requirements and acceptance criteria                                 |
| [docs/architecture.md](docs/architecture.md)                             | design, diagram, alternatives (Azure SQL, Google Sheets)             |
| [docs/data-model.md](docs/data-model.md)                                 | ER diagram, indexes, RLS, retention, time zones                      |
| [docs/whatsapp-integration.md](docs/whatsapp-integration.md)             | webhook, conversation, templates, Meta setup, verification checklist |
| [docs/privacy-security-checklist.md](docs/privacy-security-checklist.md) | controls, procedures, review checklist (not legal advice)            |
| [docs/deployment.md](docs/deployment.md)                                 | Supabase + Vercel, local dev, CI, operations                         |
| [docs/backup-restore.md](docs/backup-restore.md)                         | backups, restore, audit retention                                    |
| [docs/cost-comparison.md](docs/cost-comparison.md)                       | cost drivers (no prices asserted)                                    |
| [docs/assumptions.md](docs/assumptions.md)                               | decisions needed, assumptions, limitations                           |
| [docs/acceptance-checklist.md](docs/acceptance-checklist.md)             | manual acceptance tests                                              |
| [docs/decisions/](docs/decisions)                                        | ADRs                                                                 |
| [docs/implementation-plan.md](docs/implementation-plan.md)               | the initial plan                                                     |

## Layout

```
booking/
  supabase/migrations/   SQL schema, triggers, RLS
  src/lib/domain/        pure logic: availability, allocation, KPI, status, RBAC, time, phone
  src/lib/services/      transactions + authorisation (booking, replacement, kpi, outbox, privacy, …)
  src/lib/whatsapp/      provider interface, mock, Cloud API, parser
  src/lib/db, http/      DB transaction layer, route wrapper, sessions
  src/app/               pages and API routes (Next.js App Router)
  tests/ e2e/            Vitest (real PostgreSQL) and Playwright
  scripts/               migrate, seed
```
