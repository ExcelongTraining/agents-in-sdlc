import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Tx } from "../db/tx";
import { AppError, isAppError } from "../errors";
import { env } from "../config/env";
import { normalisePhone } from "../domain/phone";
import { formatLocal } from "../domain/time";
import type { Principal } from "../domain/rbac";
import { enqueueNotification, type NotificationPurpose } from "./notifications";
import { sha256 } from "./password";

export type BookingSource = "web" | "whatsapp" | "phone" | "walk_in" | "staff_direct" | "manager";

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** Who is performing an operation. Authorisation is checked by the service functions using this. */
export type Actor =
  | { kind: "staff"; principal: Principal }
  | { kind: "customer"; customerId: string; via: "manage_token" | "otp" | "whatsapp" }
  | { kind: "system"; reason: string };

export interface AppointmentRow {
  id: string;
  organisation_id: string;
  branch_id: string;
  customer_id: string | null;
  service_id: string;
  kind: "service" | "trial" | "consultation";
  source: BookingSource;
  status: string;
  start_at: Date;
  end_at: Date;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  counts_toward_kpi: boolean;
  room_id: string | null;
  staff_selection: "specific" | "any";
  preferred_staff_id: string | null;
  hold_expires_at: Date | null;
  version: number;
  rescheduled_from_id: string | null;
  operational_note: string | null;
  actual_minutes: number | null;
}

export interface AssignmentRow {
  id: string;
  appointment_id: string;
  staff_id: string;
  status: "active" | "superseded" | "released";
  origin: "booking" | "manager_reassign" | "replacement";
}

export async function lockAppointment(tx: Tx, id: string): Promise<{ appt: AppointmentRow; assignment: AssignmentRow | null }> {
  const appt = await tx.maybeOne<AppointmentRow>("select * from appointments where id = $1 and organisation_id = $2 for update", [id, tx.ctx.orgId]);
  if (!appt) throw new AppError("NOT_FOUND", "Appointment not found.");
  const assignment = await tx.maybeOne<AssignmentRow>("select * from appointment_assignments where appointment_id = $1 and status = 'active'", [id]);
  return { appt, assignment };
}

export const stableJson = (v: unknown): string =>
  JSON.stringify(v, (_k, val) => (val && typeof val === "object" && !Array.isArray(val) && !(val instanceof Date)
    ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : val));

/**
 * Idempotent execution. The first caller inserts the key (and runs `fn`); concurrent duplicates block on the unique
 * index until the first transaction finishes, then replay the stored response. A reused key with a different request
 * body is rejected. `fn` must return JSON-safe data.
 */
export async function idempotent<T>(tx: Tx, scope: string, key: string | undefined, request: unknown, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  if (key.length < 8 || key.length > 128) throw new AppError("VALIDATION", "Invalid idempotency key.");
  const hash = createHash("sha256").update(stableJson(request)).digest("hex");
  const inserted = await tx.query(
    "insert into idempotency_keys(organisation_id, scope, key, request_hash) values ($1,$2,$3,$4) on conflict do nothing returning key",
    [tx.ctx.orgId, scope, key, hash],
  );
  if (inserted.length === 0) {
    const row = await tx.one<{ request_hash: string; response: T | null }>(
      "select request_hash, response from idempotency_keys where organisation_id = $1 and scope = $2 and key = $3", [tx.ctx.orgId, scope, key]);
    if (row.request_hash !== hash) throw new AppError("IDEMPOTENCY_CONFLICT", "This request key was already used for a different request.");
    if (row.response !== null) return row.response;
    throw new AppError("VERSION_CONFLICT", "The original request is still being processed. Please retry shortly.");
  }
  const result = await fn();
  await tx.query("update idempotency_keys set response = $4 where organisation_id = $1 and scope = $2 and key = $3", [tx.ctx.orgId, scope, key, JSON.stringify(result)]);
  return result;
}

/** Deterministic secrets derived from APP_SECRET: nothing secret is stored, and replays can re-issue the same value. */
const hmac = (label: string, value: string): string => createHmac("sha256", env().APP_SECRET).update(`${label}:${value}`).digest("base64url");
export const holdToken = (holdId: string): string => `${holdId}.${hmac("hold", holdId)}`;
export const manageToken = (appointmentId: string): string => `${appointmentId}.${hmac("manage", appointmentId)}`;

export function verifySignedToken(token: string, label: "hold" | "manage"): string | null {
  const [id, sig] = token.split(".");
  if (!id || !sig || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const expected = hmac(label, id);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}
export const holdTokenHash = (token: string): string => sha256(token);

export function isCandidateConflict(e: unknown): boolean {
  return isAppError(e) && ["SLOT_TAKEN", "ROOM_TAKEN", "NOT_QUALIFIED", "OUTSIDE_WORKING_HOURS", "STAFF_UNAVAILABLE", "OUTSIDE_BUSINESS_HOURS"].includes(e.code);
}

export interface CustomerInput {
  name: string;
  phone: string;
  email?: string | null;
}

/** Find by phone or create. Existing records are NOT overwritten from unauthenticated input. */
export async function upsertCustomer(tx: Tx, c: CustomerInput, source: BookingSource): Promise<{ id: string; created: boolean }> {
  const phone = normalisePhone(c.phone);
  if (!phone) throw new AppError("VALIDATION", "Please enter a valid phone number, for example 012-345 6789.");
  const existing = await tx.maybeOne<{ id: string }>(
    "select id from customers where organisation_id = $1 and phone_e164 = $2 and anonymised_at is null", [tx.ctx.orgId, phone]);
  if (existing) return { id: existing.id, created: false };
  const row = await tx.one<{ id: string }>(
    `insert into customers(organisation_id, display_name, phone_e164, email, source, created_by)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (organisation_id, phone_e164) where anonymised_at is null do update set updated_at = now()
     returning id`,
    [tx.ctx.orgId, c.name.trim().slice(0, 100), phone, c.email?.trim() || null, source, tx.ctx.userId ?? null],
  );
  return { id: row.id, created: true };
}

export async function recordConsents(
  tx: Tx,
  customerId: string,
  consents: { serviceBooking: boolean; whatsapp: boolean; marketing?: boolean },
  noticeVersion: string,
  channel: BookingSource,
): Promise<void> {
  const rows: [string, boolean][] = [
    ["service_booking", consents.serviceBooking],
    ["whatsapp_messaging", consents.whatsapp],
    ["marketing", consents.marketing ?? false],
  ];
  for (const [purpose, granted] of rows) {
    // Append only when the effective state changes, so the history stays meaningful.
    const last = await tx.maybeOne<{ granted: boolean }>(
      "select granted from customer_consents where customer_id = $1 and purpose = $2 order by recorded_at desc limit 1", [customerId, purpose]);
    if (last && last.granted === granted) continue;
    if (!last && !granted && purpose !== "service_booking") continue;
    await tx.query(
      "insert into customer_consents(organisation_id, customer_id, purpose, granted, notice_version, channel, recorded_by) values ($1,$2,$3,$4,$5,$6,$7)",
      [tx.ctx.orgId, customerId, purpose, granted, noticeVersion, channel, tx.ctx.userId ?? null],
    );
  }
}

export interface BookingSummary {
  appointmentId: string;
  status: string;
  kind: string;
  source: string;
  startAt: string;
  endAt: string;
  serviceName: string;
  staffId: string | null;
  staffName: string | null;
  branchName: string;
}

export async function summarise(tx: Tx, appointmentId: string): Promise<BookingSummary> {
  const r = await tx.one<{
    id: string; status: string; kind: string; source: string; start_at: Date; end_at: Date; service_name: string;
    staff_id: string | null; staff_name: string | null; branch_name: string;
  }>(
    `select a.id, a.status, a.kind, a.source, a.start_at, a.end_at, s.name service_name, sp.id staff_id, sp.display_name staff_name, b.name branch_name
       from appointments a join services s on s.id = a.service_id join branches b on b.id = a.branch_id
       left join appointment_assignments g on g.appointment_id = a.id and g.status = 'active'
       left join staff_profiles sp on sp.id = g.staff_id
      where a.id = $1`, [appointmentId]);
  return {
    appointmentId: r.id, status: r.status, kind: r.kind, source: r.source, startAt: r.start_at.toISOString(), endAt: r.end_at.toISOString(),
    serviceName: r.service_name, staffId: r.staff_id, staffName: r.staff_name, branchName: r.branch_name,
  };
}

/** Template parameters shared by booking notifications (first name only; no phone numbers). */
export async function notificationParams(tx: Tx, appointmentId: string, tz: string): Promise<Record<string, string>> {
  const r = await tx.one<{
    start_at: Date; service_name: string; staff_name: string | null; branch_name: string; customer_name: string | null;
  }>(
    `select a.start_at, s.name service_name, sp.display_name staff_name, b.name branch_name, c.display_name customer_name
       from appointments a join services s on s.id = a.service_id join branches b on b.id = a.branch_id
       left join customers c on c.id = a.customer_id
       left join appointment_assignments g on g.appointment_id = a.id and g.status = 'active'
       left join staff_profiles sp on sp.id = g.staff_id
      where a.id = $1`, [appointmentId]);
  return {
    customer: (r.customer_name ?? "there").split(" ")[0] ?? "there",
    service: r.service_name,
    staff: r.staff_name ?? "our team",
    date: formatLocal(r.start_at, tz, "EEE d MMM"),
    time: formatLocal(r.start_at, tz, "h:mm a"),
    branch: r.branch_name,
    manageToken: manageToken(appointmentId),
  };
}

export async function branchTimezone(tx: Tx, branchId: string): Promise<string> {
  return (await tx.one<{ timezone: string }>("select timezone from branches where id = $1", [branchId])).timezone;
}

export async function notifyBooking(
  tx: Tx,
  purpose: Extract<NotificationPurpose, "booking_confirmed" | "booking_changed" | "booking_cancelled" | "booking_request_received" | "appointment_reminder">,
  appt: { id: string; branch_id: string; customer_id: string | null },
  dedupeSuffix: string,
  sendAt?: Date,
): Promise<void> {
  if (!appt.customer_id) return;
  const params = await notificationParams(tx, appt.id, await branchTimezone(tx, appt.branch_id));
  await enqueueNotification(tx, {
    purpose, recipientKind: "customer", recipientId: appt.customer_id, params, appointmentId: appt.id,
    dedupeKey: `${purpose}:${appt.id}:${dedupeSuffix}`, sendAt,
  });
}

export async function notifyStaff(
  tx: Tx,
  purpose: Extract<NotificationPurpose, "assignment_new" | "assignment_removed">,
  staffId: string,
  appt: { id: string; branch_id: string },
  dedupeSuffix: string,
): Promise<void> {
  const params = await notificationParams(tx, appt.id, await branchTimezone(tx, appt.branch_id));
  await enqueueNotification(tx, {
    purpose, recipientKind: "staff", recipientId: staffId, params, appointmentId: appt.id,
    dedupeKey: `${purpose}:${appt.id}:${staffId}:${dedupeSuffix}`,
  });
}

/** Mark expired holds. Called inside every booking transaction (lazy) and by the cron sweeper. */
export async function expireHolds(tx: Tx, now: Date): Promise<number> {
  await tx.setStatusReason("hold expired");
  const rows = await tx.query<{ id: string }>(
    `update appointments set status = 'expired', updated_by = null
      where id in (select id from appointments where organisation_id = $1 and status = 'slot_held' and hold_expires_at <= $2
                    order by hold_expires_at for update skip locked)
      returning id`,
    [tx.ctx.orgId, now],
  );
  if (rows.length) {
    await tx.query("update slot_holds set status = 'expired' where appointment_id = any($1) and status = 'active'", [rows.map((r) => r.id)]);
  }
  await tx.setStatusReason(null);
  return rows.length;
}
