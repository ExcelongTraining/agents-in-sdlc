# ADR-0003: Authorisation in code, routes and database

- Status: accepted
- Decision: (1) permission matrix in `domain/rbac.ts` checked by services (`requirePermission`) and by `route({ permission })`; (2) server-component guards (`requireRole`) so no page renders for the wrong role; (3) PostgreSQL RLS with two roles (`booking_staff`, `booking_system`), column privileges (no `password_hash` for staff), append-only `audit_logs`, and admin-facing views without payloads.
- The **administrator** role has no schedule, customer, message or KPI permission; it sees only technical status and audit.
- Masseuses read only their own appointments; their view of customers is first name + masked phone.
- Rejected: relying on hidden UI controls (explicitly disallowed by the brief).
- Known trade-off: the booking engine runs as `booking_system` so it can see all bookings for availability. Authorisation precedes it. See `architecture.md` §Database roles.
