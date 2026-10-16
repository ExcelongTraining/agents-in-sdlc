# ADR-0001: PostgreSQL (Supabase-compatible) is the single source of truth

- Status: accepted
- Context: five or more masseuses, a manager and four booking channels create races and divergent schedules. We need atomic conflict prevention, row-level security, audit and a low-ops managed service.
- Decision: PostgreSQL 15+ with `btree_gist`. Access through `pg` (a thin typed layer, Zod-validated inputs) and plain SQL migrations in `supabase/migrations` (run by `scripts/migrate.ts` or `supabase db push`).
- Why not Prisma/ORM: exclusion constraints, deferred triggers, RLS and `SET LOCAL ROLE` must be written in SQL anyway; an ORM would add a second schema source of truth and an engine binary. SQL is portable between Postgres hosts; moving to another database would mean porting the migrations and replacing exclusion constraints (see `architecture.md` §Comparison).
- Consequences: strong guarantees; SQL knowledge needed for changes; the app depends on Postgres-specific features (ranges, exclusion, RLS).
