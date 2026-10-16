import { randomInt } from "node:crypto";
import { z } from "zod";
import { withTx } from "../db/tx";
import { AppError } from "../errors";
import { requirePermission, type Principal } from "../domain/rbac";
import { auditEvent } from "./audit";
import { ctxFor } from "./booking";
import { loadSettings } from "./settings";
import { systemClock, type Clock } from "./booking-shared";

/** Data-subject ACCESS request: everything we hold about one customer, as JSON the manager can hand over after verifying identity. */
export async function exportCustomerData(principal: Principal, customerId: string): Promise<Record<string, unknown>> {
  requirePermission(principal, "privacy.manage");
  return withTx(ctxFor(principal.orgId, { kind: "staff", principal }), async (tx) => {
    const customer = await tx.maybeOne("select id, display_name, phone_e164, email, source, operational_note, created_at, anonymised_at from customers where id = $1", [customerId]);
    if (!customer) throw new AppError("NOT_FOUND", "Customer not found.");
    const data = {
      generatedAt: new Date().toISOString(),
      customer,
      consents: await tx.query("select purpose, granted, notice_version, channel, recorded_at from customer_consents where customer_id = $1 order by recorded_at", [customerId]),
      appointments: await tx.query(
        `select a.id, a.status, a.source, a.start_at, a.end_at, s.name as service, a.operational_note, a.created_at
           from appointments a join services s on s.id = a.service_id where a.customer_id = $1 order by a.start_at`, [customerId]),
      whatsappMessages: await tx.query(
        `select m.direction, m.msg_type, m.body, m.status, m.occurred_at from whatsapp_messages m join whatsapp_contacts c on c.id = m.contact_id
          where c.customer_id = $1 order by m.occurred_at`, [customerId]),
      waitlist: await tx.query("select service_id, window_start, window_end, status, created_at from waitlist_entries where customer_id = $1", [customerId]),
    };
    await auditEvent(tx, { action: "privacy.export", entityType: "customers", entityId: customerId });
    return data;
  });
}

/**
 * DELETION request. Personal identifiers are irreversibly removed; appointment rows stay (without notes) so staff hours,
 * KPIs and business records remain correct. Refused while future bookings exist: cancel them first.
 */
export async function anonymiseCustomer(principal: Principal, customerId: string, reason: string, clock: Clock = systemClock): Promise<void> {
  requirePermission(principal, "privacy.manage");
  if (reason.trim().length < 5) throw new AppError("VALIDATION", "Record why (e.g. the request reference).");
  await withTx(ctxFor(principal.orgId, { kind: "staff", principal }), async (tx) => {
    const c = await tx.maybeOne<{ phone_e164: string }>("select phone_e164 from customers where id = $1 and anonymised_at is null for update", [customerId]);
    if (!c) throw new AppError("NOT_FOUND", "Customer not found or already anonymised.");
    const open = await tx.one<{ n: number }>(
      "select count(*)::int n from appointments where customer_id = $1 and status in ('confirmed','pending_confirmation','checked_in','in_progress','replacement_pending') and end_at > $2", [customerId, clock.now()]);
    if (open.n > 0) throw new AppError("NOT_ALLOWED", "This customer has upcoming bookings. Cancel them before deleting the record.");
    await tx.setAuditReason(reason);
    const placeholder = `+999${String(randomInt(0, 1e11)).padStart(11, "0")}`; // matches the format check, never a real number
    await tx.query(
      `update customers set display_name = 'Deleted customer', phone_e164 = $2, email = null, operational_note = null, preferred_staff_id = null,
              anonymised_at = now(), updated_by = $3 where id = $1`, [customerId, placeholder, principal.userId]);
    await tx.query("update appointments set operational_note = null where customer_id = $1", [customerId]);
    const waId = c.phone_e164.replace(/\D/g, "");
    await tx.query("update whatsapp_messages set body = null where contact_id in (select id from whatsapp_contacts where wa_id = $1 and organisation_id = $2)", [waId, principal.orgId]);
    await tx.query("update whatsapp_contacts set customer_id = null, profile_name = null, wa_id = 'deleted:' || id::text where wa_id = $1 and organisation_id = $2", [waId, principal.orgId]);
    await tx.query("delete from booking_access_tokens where customer_id = $1", [customerId]);
    await tx.query("delete from booking_otps where customer_id = $1", [customerId]);
    await tx.query("delete from waitlist_entries where customer_id = $1 and status in ('waiting','offered')", [customerId]);
    await tx.query("update notification_jobs set status = 'skipped', params = '{}' where recipient_kind = 'customer' and recipient_id = $1 and status in ('pending','failed')", [customerId]);
    await auditEvent(tx, { action: "privacy.anonymise", entityType: "customers", entityId: customerId, reason });
  });
}

export const dataRequestSchema = z.object({ customerId: z.uuid().optional(), kind: z.enum(["access", "correction", "deletion"]), note: z.string().max(500).optional() });
export async function logDataRequest(principal: Principal, raw: z.input<typeof dataRequestSchema>): Promise<{ id: string; dueAt: Date }> {
  requirePermission(principal, "privacy.manage");
  const i = dataRequestSchema.parse(raw);
  return withTx(ctxFor(principal.orgId, { kind: "staff", principal }), async (tx) => {
    const r = await tx.one<{ id: string; due_at: Date }>(
      "insert into data_requests(organisation_id, customer_id, kind, note, handled_by) values ($1,$2,$3,$4,$5) returning id, due_at", [principal.orgId, i.customerId ?? null, i.kind, i.note ?? null, principal.userId]);
    return { id: r.id, dueAt: r.due_at };
  });
}

/** Daily retention job driven by application_settings.retention. Returns counts for the ops log. */
export async function runRetention(orgId: string, clock: Clock = systemClock): Promise<Record<string, number>> {
  return withTx({ kind: "system", orgId, actor: "job" }, async (tx) => {
    const s = (await loadSettings(tx)).retention;
    const now = clock.now();
    const ago = (days: number) => new Date(now.getTime() - days * 86400_000);
    const res: Record<string, number> = {};
    res.webhookEvents = (await tx.query("delete from webhook_events where received_at < $1 and status in ('processed','dead') returning id", [ago(s.webhookEventDays)])).length;
    res.whatsappBodies = (await tx.query("update whatsapp_messages set body = null where body is not null and occurred_at < $1 returning id", [ago(s.whatsappMessageDays)])).length;
    res.idempotencyKeys = (await tx.query("delete from idempotency_keys where created_at < $1 returning key", [ago(7)])).length;
    res.rateLimits = (await tx.query("delete from rate_limits where window_start < $1 returning key", [ago(1)])).length;
    res.sessions = (await tx.query("delete from sessions where expires_at < $1 returning id", [now])).length;
    res.customerTokens = (await tx.query("delete from booking_access_tokens where expires_at < $1 returning id", [ago(1)])).length;
    res.otps = (await tx.query("delete from booking_otps where expires_at < $1 returning id", [ago(1)])).length;
    res.finishedJobs = (await tx.query("delete from notification_jobs where status in ('sent','skipped') and created_at < $1 returning id", [ago(30)])).length;
    // Customers with no activity for the configured period are anonymised (no future bookings by definition).
    const stale = await tx.query<{ id: string }>(
      `select c.id from customers c where c.organisation_id = $1 and c.anonymised_at is null
          and coalesce((select max(a.end_at) from appointments a where a.customer_id = c.id), c.created_at) < $2`,
      [orgId, new Date(now.getTime() - s.customerInactiveMonths * 30.44 * 86400_000)]);
    res.customersAnonymised = 0;
    for (const c of stale) {
      await tx.query(
        `update customers set display_name = 'Deleted customer', phone_e164 = $2, email = null, operational_note = null, preferred_staff_id = null, anonymised_at = now() where id = $1`,
        [c.id, `+999${String(randomInt(0, 1e11)).padStart(11, "0")}`]);
      res.customersAnonymised++;
    }
    await auditEvent(tx, { action: "privacy.retention_run", entityType: "organisations", entityId: orgId, data: res });
    return res;
  });
}
