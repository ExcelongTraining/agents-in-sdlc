# ADR-0002: Conflict prevention with exclusion constraints (plus triggers and holds in the same domain)

- Status: accepted

## Problem

The sequence _read availability → show → insert later_ is a race. Two requests can both see a free slot and both insert.

## Options

1. **Serializable transactions + retry.** Correct, but every code path (including future ones, manual SQL, imports) must use the right isolation level and retry logic; a mistake silently allows double-booking. Throughput suffers under contention because of predicate-lock false positives.
2. **Application-level locks (advisory/`SELECT … FOR UPDATE`) only.** Correct only while every writer cooperates.
3. **Declarative exclusion constraints** (`EXCLUDE USING gist (staff_id WITH =, occupied WITH &&) WHERE (status='active')`). The database rejects overlapping rows at any isolation level, for any writer. Cost: needs `btree_gist`; overlap rules expressible as a constraint only within one table.

## Decision

- **Staff overlap**: exclusion constraint on `appointment_assignments(staff_id, occupied)` where `occupied = [start − buffer_before, end + buffer_after)`.
- **Room overlap**: exclusion constraint on `appointments(room_id, occupied)` for blocking statuses.
- **Holds are real rows** (`status='slot_held'`) in the same constraints, so a hold and a booking cannot both exist for the same time. `occupied` is computed by trigger (timestamp arithmetic is not immutable, so it cannot be a generated column).
- **Rules that cross tables** (qualification, working hours, business hours, leave/break/closure, immutability, status transitions) are `BEFORE` triggers marked `SECURITY DEFINER`. Leave-vs-booking races are closed by a per-staff `pg_advisory_xact_lock` taken by both the assignment trigger and the exception trigger.
- **Hold expiry** cannot be in a constraint predicate (no `now()`), so expired holds are released _inside every booking transaction_ before inserting, and by the cron tick. Correctness never depends on cron.
- **"Any available"** tries ranked candidates in savepoints; a `23P01` just moves to the next candidate.
- **Idempotency**: `idempotency_keys(org, scope, key, request_hash, response)`; concurrent duplicates serialise on the unique index and the later one replays the stored response.
- Isolation level stays `READ COMMITTED`; serialization failures/deadlocks are retried by `withTx`.

## Verification

`tests/booking.integration.test.ts`: 8 concurrent bookings for the same masseuse/time → exactly one succeeds (5 rounds); concurrent holds; "any" under contention; the exclusion constraint alone blocks overlap with all triggers disabled (`session_replication_role = replica`).

## Consequences

A booking is confirmed only if the transaction commits; the UI list of free slots is advisory.
