# Backup and restore

## What to protect

PostgreSQL holds everything (bookings, customers, consents, audit, settings). The application is stateless; secrets live in the host's secret store (record where, outside this repo).

## Backups

- **Managed point-in-time recovery** (recommended): enable the provider's daily backups and PITR (Supabase: Database → Backups; PITR is an add-on on some plans — confirm for your plan). Confirm backups are encrypted at rest and stored in an approved region.
- **Logical dump (independent copy)**, daily to encrypted storage you control:

  ```bash
  pg_dump --format=custom --no-owner --file="booking-$(date +%F).dump" "$DATABASE_URL"
  # encrypt before storing off-site, e.g. age/gpg; retain per your policy
  ```

- Retention of backups must be consistent with your retention policy: **a deleted/anonymised customer reappears in older backups**. Define how long backups live and how deletion requests are re-applied after a restore (`data_requests` + `audit_logs` record what was anonymised; re-run `anonymiseCustomer` for each after restoring).

## Restore procedure

1. Declare an incident; stop writes (set the app to maintenance by pausing the deployment or revoking `DATABASE_URL`).
2. Create a new database (or restore PITR to a new project).
3. Prepare the target. Roles are cluster-level and are **not** part of a database dump, so create them first, plus the extension:
   ```sql
   create role booking_system nologin;
   create role booking_staff nologin;
   grant booking_system, booking_staff to <your connection user>;
   create extension if not exists btree_gist;
   ```
   Then restore: `pg_restore --no-owner --dbname "$NEW_DATABASE_URL" booking-YYYY-MM-DD.dump` (grants and policies are inside the dump). With a provider PITR restore the roles already exist.
4. Verify: `npm run db:migrate` reports up to date; run the smoke checks below; compare row counts of `appointments`, `customers`, `audit_logs` with the source.
5. Point `DATABASE_URL` to the new database, redeploy, run the cron tick once (`/api/cron/tick`) so queued notifications resume.
6. **After a restore, review notification jobs**: jobs sent after the backup time may be re-sent. Set `status='skipped'` for pending jobs whose appointments are already past or unwanted.
7. Re-apply deletions recorded after the backup (see above). Record the incident.

Smoke checks:

```sql
select count(*) from appointments where status in ('confirmed','pending_confirmation');
select count(*) from (select staff_id from appointment_assignments where status='active'
   group by staff_id having count(*) > 0) s;           -- sanity
-- no overlapping active assignments (should return 0 rows):
select a.id, b.id from appointment_assignments a join appointment_assignments b
  on a.staff_id=b.staff_id and a.id<b.id and a.status='active' and b.status='active' and a.occupied && b.occupied;
```

## Test your restore

Restore the latest backup into a scratch database at least quarterly and run the smoke checks. Untested backups are assumptions.

## Audit log retention

`audit_logs` is append-only (trigger `BK009`) so tampering needs a deliberate DBA action. To purge rows older than your retention period: take a backup, then in a maintenance window as the table owner run `ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update;`, `DELETE FROM audit_logs WHERE occurred_at < now() - interval '84 months';`, `ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update;` and record the action in your change log. (Automating this is intentionally left out.)

## Disaster scenarios

| Scenario                        | Action                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Accidental data change by staff | Use `audit_logs` (before/after values) to reverse; for appointments use cancel/reschedule flows                  |
| Corrupt deploy                  | Redeploy previous build; migrations are forward-only, so ship a corrective migration rather than editing history |
| Provider outage                 | App is down; the manager keeps the last printed/exported schedule; on recovery run the cron tick                 |
| WhatsApp outage                 | Bookings continue; notifications retry and dead-letter; dashboard alert; phone customers if urgent               |
