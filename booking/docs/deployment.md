# Deployment

Target: Vercel (or any Node 20+ host) + Supabase (or any PostgreSQL 15+ with `btree_gist`). Region choice affects personal-data location: decide with your privacy adviser (Singapore is the nearest common region for both providers; verify availability).

## 1. Database

1. Create the Postgres database (Supabase project). Note the connection string. For serverless hosting prefer the provider's pooled connection (Supabase "transaction"/"session" pooler). The app uses plain parameterised queries and `SET LOCAL` inside transactions, which are safe with transaction pooling; avoid features needing session state.
2. Apply migrations:
   ```bash
   DATABASE_URL=postgres://… npm run db:migrate          # or: supabase db push (the SQL files in supabase/migrations are Supabase-CLI compatible)
   ```
   The connection user must be allowed to `CREATE ROLE` for migration 005 (Supabase `postgres` is) or the roles `booking_system` and `booking_staff` must pre-exist (then the `CREATE ROLE` is skipped) and be granted to the connection user.
3. Create the **real** organisation, branch, staff and services. **Do not run the demo seed in production** (`npm run db:seed` refuses when `NODE_ENV=production`). Either adapt `src/lib/seed/base.ts` to your real data once, or create users in the UI after inserting the organisation:
   ```sql
   insert into organisations(name, slug) values ('Your Centre', 'your-slug');
   insert into branches(organisation_id, name, address) select id, 'Main', '…' from organisations where slug='your-slug';
   ```
   then create the first manager with a one-off script using `hashPassword` from `src/lib/services/password.ts`, and add everyone else through **Manager → Team**. Enable Supabase's "Enforce SSL".
4. Do not expose the database's REST/GraphQL (PostgREST) API publicly for these tables: the app talks to Postgres directly. RLS is on for every table, and anonymous/authenticated Supabase roles have no policies, so they see nothing; still disable the Data API in Supabase settings if you do not need it.

## 2. Application (Vercel)

1. Import the repository; set **Root Directory** to `booking`; framework Next.js; Node 20+.
2. Environment variables (Production), see `.env.example`:
   `DATABASE_URL`, `DATABASE_SSL=true`, `APP_BASE_URL=https://<domain>`, `APP_SECRET` (32+ random chars), `CRON_SECRET`, `ORG_SLUG`, `WHATSAPP_PROVIDER` (`mock` until Meta is ready, then `cloud`) and the four `WHATSAPP_*` secrets. Mark secrets as sensitive; never prefix with `NEXT_PUBLIC_`.
3. Custom domain with HTTPS; set `APP_BASE_URL` to it exactly (used for CSRF origin checks and links in WhatsApp).
4. **Scheduler.** `vercel.json` registers `/api/cron/tick` every minute. Per-minute cron may require a paid Vercel plan (verify current limits). If not available, call the same URL every 1–5 minutes from any scheduler with the header `Authorization: Bearer $CRON_SECRET` (GitHub Actions `schedule`, Supabase `pg_cron` + `pg_net`, cron-job.org). The tick is idempotent and safe to run concurrently.
5. Deploy. Check `/api/public/catalog` returns services and that `/login` works.

## 3. First-day checklist

- [ ] Change all seeded/demo passwords (or never seed). Use passwords of 12+ characters.
- [ ] Manager phone numbers set (Team) so hand-off/approval alerts are delivered; masseuses' numbers set.
- [ ] Business hours, rooms and services configured (Manager → Settings, Services).
- [ ] Working hours for each masseuse; qualifications on each service.
- [ ] Privacy notice reviewed and adopted (`src/app/privacy/page.tsx`); `NOTICE_VERSION` bumped.
- [ ] WhatsApp: see `whatsapp-integration.md`; templates approved and status updated.
- [ ] Remove `robots: { index: false }` from `src/app/layout.tsx` and the “(demo)” naming when going live.
- [ ] Backups enabled and one restore tested (`backup-restore.md`).
- [ ] Run the manual acceptance checklist (`acceptance-checklist.md`) against production with the mock provider, then with a sandbox number.

## 4. Local development

```bash
cd booking
cp .env.example .env.local            # edit DATABASE_URL etc.
createdb booking                      # PostgreSQL 15+ running locally
npm ci
npm run db:reset                      # drops the public schema, migrates, seeds fictional data (refuses in production)
npm run dev                           # http://localhost:3000
```

Demo logins (password `Demo-Password-2026!` unless `SEED_PASSWORD`): `manager@lotus-demo.example`, `aisyah@…`, `meiling@…`, `priya@…`, `farah@…`, `lakshmi@…`, `admin@lotus-demo.example`.

### Tests

```bash
export TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres   # a superuser; tests create/drop throw-away databases
npm run typecheck && npm run lint && npm test            # 130+ unit/integration tests against real PostgreSQL
npx playwright install chromium                          # once
npm run test:e2e                                         # mobile-viewport browser tests incl. axe accessibility
```

No WhatsApp account is needed: tests use the mock provider.

## 5. CI

`.github/workflows/booking-ci.yml` (repository root) runs on changes under `booking/`: typecheck, lint, format check, `npm audit --omit=dev`, unit/integration tests with a PostgreSQL 16 service, build, and Playwright E2E.

## 6. Operations

- Monitor: dashboard alerts (failed/dead notifications, waiting hand-offs), host logs (JSON; phone numbers masked), `v_webhook_events_admin`.
- Weekly: glance at dead-lettered notifications and the audit log.
- Monthly: dependency updates, secret hygiene review, restore test (quarterly).
- Upgrades: migrations are forward-only; add new files, never edit applied ones.
