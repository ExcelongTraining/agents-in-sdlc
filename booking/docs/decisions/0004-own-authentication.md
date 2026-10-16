# ADR-0004: Application-managed staff authentication; customers have no accounts

- Status: accepted
- Context: the brief prefers Supabase for authentication. The system must run, be tested and be deployable without a live Supabase project, and RLS needs the user/role in a transaction-local setting.
- Decision: email + password (scrypt N=32768, r=8, p=1, per-user salt), opaque random session tokens (only `sha256` stored), HttpOnly + Secure + SameSite=Lax cookie, 12 h sessions, per-IP and per-email rate limits, account lock after 5 failures (15 min), forced password change for admin-created accounts, other sessions revoked on password change. Passwords are never logged. Staff authentication never uses a phone number.
- Customers: no password. (a) appointment-scoped HMAC-signed link (`APP_SECRET`), expiring a week after the appointment; (b) WhatsApp 6-digit one-time code (hashed, 10 min, 5 attempts, rate limited) that issues a 30-minute token for _that customer's_ bookings.
- Supabase Auth can be adopted later by replacing `services/auth.ts` (the rest of the system only needs `Principal`). Recommended addition before go-live: MFA for manager/administrator.
