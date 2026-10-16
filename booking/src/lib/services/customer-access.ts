import { createHash, randomInt } from "node:crypto";
import { withTx } from "../db/tx";
import { AppError } from "../errors";
import { normalisePhone } from "../domain/phone";
import { formatLocal } from "../domain/time";
import { enqueueNotification } from "./notifications";
import { newToken, sha256 } from "./password";
import { rateLimit } from "./rate-limit";
import { type Clock, systemClock, verifySignedToken } from "./booking-shared";

const OTP_MINUTES = 10;
const SESSION_MINUTES = 30;
const MAX_OTP_ATTEMPTS = 5;

/** Customers are never accounts. Two ways in: an appointment-scoped manage link, or a WhatsApp one-time code. */
export type CustomerAccess = { customerId: string; appointmentId?: string };

/** Resolve a manage-link token (from the confirmation page or WhatsApp) to the customer and the ONE appointment it covers. */
export async function accessFromManageToken(orgId: string, token: string, clock: Clock = systemClock): Promise<CustomerAccess | null> {
  const appointmentId = verifySignedToken(token, "manage");
  if (!appointmentId) return null;
  return withTx({ kind: "system", orgId, actor: "customer" }, async (tx) => {
    const a = await tx.maybeOne<{ customer_id: string | null; end_at: Date }>("select customer_id, end_at from appointments where id = $1", [appointmentId]);
    if (!a?.customer_id) return null;
    if (a.end_at.getTime() + 7 * 86400_000 < clock.now().getTime()) return null; // links expire a week after the appointment
    return { customerId: a.customer_id, appointmentId };
  });
}

/**
 * Ask for a one-time code. The response is identical whether or not the number is known, so this cannot be used to
 * discover who is a customer. Limited per phone number and per IP.
 */
export async function requestOtp(orgId: string, phoneInput: string, ip: string, clock: Clock = systemClock): Promise<void> {
  const phone = normalisePhone(phoneInput);
  if (!phone) return;
  await withTx({ kind: "system", orgId, actor: "customer" }, async (tx) => {
    await rateLimit(tx, `otp:phone:${sha256(phone).slice(0, 24)}`, 3, 3600);
    await rateLimit(tx, `otp:ip:${ip}`, 20, 3600);
    const c = await tx.maybeOne<{ id: string }>("select id from customers where organisation_id = $1 and phone_e164 = $2 and anonymised_at is null", [orgId, phone]);
    if (!c) return;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await tx.query("update booking_otps set consumed_at = now() where customer_id = $1 and consumed_at is null", [c.id]);
    const otp = await tx.one<{ id: string }>(
      "insert into booking_otps(organisation_id, customer_id, code_hash, expires_at) values ($1,$2,$3,$4) returning id",
      [orgId, c.id, hashCode(c.id, code), new Date(clock.now().getTime() + OTP_MINUTES * 60_000)]);
    await enqueueNotification(tx, { purpose: "customer_otp", recipientKind: "customer", recipientId: c.id, params: { code }, dedupeKey: `otp:${otp.id}` });
  });
}

const hashCode = (customerId: string, code: string): string => createHash("sha256").update(`${customerId}:${code}`).digest("hex");

/** Exchange phone + code for a short-lived access token. Always the same generic error on failure. */
export async function verifyOtp(orgId: string, phoneInput: string, code: string, ip: string, clock: Clock = systemClock): Promise<{ token: string; expiresAt: Date }> {
  const fail = new AppError("UNAUTHENTICATED", "That code is not valid or has expired.");
  const phone = normalisePhone(phoneInput);
  if (!phone || !/^\d{6}$/.test(code)) throw fail;
  const res = await withTx({ kind: "system", orgId, actor: "customer" }, async (tx) => {
    await rateLimit(tx, `otpv:ip:${ip}`, 30, 3600);
    const c = await tx.maybeOne<{ id: string }>("select id from customers where organisation_id = $1 and phone_e164 = $2 and anonymised_at is null", [orgId, phone]);
    if (!c) return null;
    const otp = await tx.maybeOne<{ id: string; code_hash: string; attempts: number }>(
      "select id, code_hash, attempts from booking_otps where customer_id = $1 and consumed_at is null and expires_at > $2 order by created_at desc limit 1 for update", [c.id, clock.now()]);
    if (!otp || otp.attempts >= MAX_OTP_ATTEMPTS) return null;
    if (otp.code_hash !== hashCode(c.id, code)) {
      await tx.query("update booking_otps set attempts = attempts + 1 where id = $1", [otp.id]);
      return { failed: true as const };
    }
    await tx.query("update booking_otps set consumed_at = now() where id = $1", [otp.id]);
    const token = newToken();
    const expiresAt = new Date(clock.now().getTime() + SESSION_MINUTES * 60_000);
    await tx.query("insert into booking_access_tokens(organisation_id, customer_id, token_hash, expires_at) values ($1,$2,$3,$4)", [orgId, c.id, sha256(token), expiresAt]);
    return { token, expiresAt };
  });
  if (!res || "failed" in res) throw fail;
  return res;
}

export async function accessFromOtpToken(orgId: string, token: string, clock: Clock = systemClock): Promise<CustomerAccess | null> {
  if (!token || token.length < 20) return null;
  return withTx({ kind: "system", orgId, actor: "customer" }, async (tx) => {
    const r = await tx.maybeOne<{ customer_id: string }>(
      "select customer_id from booking_access_tokens where token_hash = $1 and revoked_at is null and expires_at > $2", [sha256(token), clock.now()]);
    return r ? { customerId: r.customer_id } : null;
  });
}

export interface CustomerBookingView {
  appointmentId: string;
  status: string;
  serviceName: string;
  staffName: string | null;
  branchName: string;
  startAt: string;
  endAt: string;
  startLocal: string;
  canChange: boolean;
}

/** A customer's own bookings. The customer id comes from a verified token, never from request input. */
export async function listCustomerBookings(orgId: string, access: CustomerAccess, clock: Clock = systemClock): Promise<CustomerBookingView[]> {
  return withTx({ kind: "system", orgId, actor: "customer" }, async (tx) => {
    const cutoff = (await tx.maybeOne<{ value: { booking?: { changeCutoffHours?: number } } | number }>("select value from application_settings where key = 'booking'"));
    const hours = (cutoff && typeof cutoff.value === "object" && (cutoff.value as { changeCutoffHours?: number }).changeCutoffHours) || 24;
    const rows = await tx.query<{ id: string; status: string; start_at: Date; end_at: Date; service: string; staff: string | null; branch: string; tz: string }>(
      `select a.id, a.status, a.start_at, a.end_at, s.name service, sp.display_name staff, b.name branch, b.timezone tz
         from appointments a join services s on s.id = a.service_id join branches b on b.id = a.branch_id
         left join appointment_assignments g on g.appointment_id = a.id and g.status = 'active'
         left join staff_profiles sp on sp.id = g.staff_id
        where a.customer_id = $1 and ($2::uuid is null or a.id = $2) and a.status in ('confirmed','pending_confirmation','replacement_pending','checked_in','in_progress')
          and a.end_at > $3 order by a.start_at limit 50`,
      [access.customerId, access.appointmentId ?? null, clock.now()]);
    return rows.map((r) => ({
      appointmentId: r.id, status: r.status === "replacement_pending" ? "confirmed" : r.status, serviceName: r.service, staffName: r.staff, branchName: r.branch,
      startAt: r.start_at.toISOString(), endAt: r.end_at.toISOString(), startLocal: formatLocal(r.start_at, r.tz),
      canChange: ["confirmed", "pending_confirmation"].includes(r.status) && r.start_at.getTime() - clock.now().getTime() >= hours * 3600_000,
    }));
  });
}

/** Ownership check used by every customer-facing mutation. Foreign ids look exactly like missing ones. */
export function assertOwns(access: CustomerAccess, ownerId: string | null, appointmentId: string): void {
  if (!ownerId || ownerId !== access.customerId || (access.appointmentId && access.appointmentId !== appointmentId))
    throw new AppError("NOT_FOUND", "Booking not found.");
}
