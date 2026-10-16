import { z } from "zod";
import { withTx, type DbContext, type Tx } from "../db/tx";
import { AppError } from "../errors";
import { addMinutes, minutesBetween } from "../domain/time";
import { canTransition, type AppointmentStatus } from "../domain/status";
import { rankCandidates, type AllocationCandidate } from "../domain/allocation";
import { can, requirePermission, type Principal } from "../domain/rbac";
import { auditEvent } from "./audit";
import { loadBranch, loadService, qualifiedStaff, type ServiceRow } from "./availability";
import {
  type Actor,
  type BookingSource,
  type BookingSummary,
  type Clock,
  type CustomerInput,
  expireHolds,
  holdToken,
  holdTokenHash,
  idempotent,
  isCandidateConflict,
  lockAppointment,
  manageToken,
  notifyBooking,
  notifyStaff,
  recordConsents,
  summarise,
  systemClock,
  upsertCustomer,
  verifySignedToken,
  type AppointmentRow,
} from "./booking-shared";
import { loadSettings, type Settings } from "./settings";
import { newToken } from "./password";
import { randomUUID } from "node:crypto";

const OVERRIDABLE = ["working_hours", "business_hours", "break"] as const;
export const overrideSchema = z.object({
  rules: z.array(z.enum(OVERRIDABLE)).min(1),
  reason: z.string().trim().min(5, "A reason of at least 5 characters is required").max(300),
});
export type Override = z.infer<typeof overrideSchema>;

export function ctxFor(orgId: string, actor: Actor, requestId?: string): DbContext {
  if (actor.kind === "staff")
    return { kind: "system", orgId, actor: "user", userId: actor.principal.userId, requestId };
  if (actor.kind === "customer")
    return { kind: "system", orgId, actor: actor.via === "whatsapp" ? "whatsapp" : "customer", requestId };
  return { kind: "system", orgId, actor: "system", requestId };
}

const BLOCKING_SQL =
  "('slot_held','pending_confirmation','confirmed','checked_in','in_progress','completed','replacement_pending')";

// ---------------------------------------------------------------------------------------------
// Staff ranking for "any available masseuse"
// ---------------------------------------------------------------------------------------------
async function rankStaff(
  tx: Tx,
  staff: { id: string }[],
  p: { startAt: Date; endAt: Date; serviceMinutes: number; preferredStaffId?: string | null; now: Date },
  settings: Settings,
): Promise<{ staffId: string; reason: string }[]> {
  if (staff.length === 0) return [];
  const w = settings.allocation.windowDays;
  const ids = staff.map((s) => s.id);
  const load = await tx.query<{
    staff_id: string;
    minutes: number;
    last_assigned: Date | null;
    weight: number;
    max_consec: number | null;
  }>(
    `select sp.id staff_id, sp.fairness_weight::float weight, sp.max_consecutive_minutes max_consec,
            coalesce(sum(extract(epoch from (a.end_at - a.start_at)) / 60) filter (where a.id is not null), 0)::int minutes,
            max(g.assigned_at) last_assigned
       from staff_profiles sp
       left join appointment_assignments g on g.staff_id = sp.id and g.status = 'active'
       left join appointments a on a.id = g.appointment_id and a.status in ${BLOCKING_SQL}
            and a.start_at between $2::timestamptz - make_interval(days => $3) and $2::timestamptz + make_interval(days => $3)
      where sp.id = any($1) group by sp.id`,
    [ids, p.now, w],
  );
  const gap = settings.allocation.adjacencyGapMinutes;
  const near = await tx.query<{ staff_id: string; s: Date; e: Date }>(
    `select g.staff_id, a.start_at s, a.end_at e from appointment_assignments g join appointments a on a.id = g.appointment_id
      where g.status = 'active' and g.staff_id = any($1) and a.status in ${BLOCKING_SQL}
        and a.end_at >= $2::timestamptz - interval '12 hours' and a.start_at <= $3::timestamptz + interval '12 hours'`,
    [ids, p.startAt, p.endAt],
  );
  const cands: AllocationCandidate[] = load.map((l) => {
    let lo = p.startAt.getTime();
    let hi = p.endAt.getTime();
    const mine = near.filter((n) => n.staff_id === l.staff_id).sort((a, b) => a.s.getTime() - b.s.getTime());
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of mine) {
        if (n.e.getTime() <= lo && lo - n.e.getTime() <= gap * 60_000 && n.s.getTime() < lo) {
          lo = n.s.getTime();
          changed = true;
        }
        if (n.s.getTime() >= hi && n.s.getTime() - hi <= gap * 60_000 && n.e.getTime() > hi) {
          hi = n.e.getTime();
          changed = true;
        }
      }
    }
    return {
      staffId: l.staff_id,
      allocatedMinutes: l.minutes,
      fairnessWeight: l.weight,
      lastAssignedAt: l.last_assigned,
      adjacentChainMinutes: Math.round((hi - lo) / 60_000) - p.serviceMinutes,
      maxConsecutiveMinutes: l.max_consec,
    };
  });
  return rankCandidates(cands, {
    serviceMinutes: p.serviceMinutes,
    preferredStaffId: settings.allocation.respectCustomerPreference ? p.preferredStaffId : null,
    defaultMaxConsecutiveMinutes: settings.allocation.defaultMaxConsecutiveMinutes,
  }).map((r) => ({ staffId: r.staffId, reason: r.reason }));
}

// ---------------------------------------------------------------------------------------------
// Core insert: appointment + assignment (+ room). Everything the database must enforce happens here, in one transaction.
// ---------------------------------------------------------------------------------------------
interface PlaceParams {
  service: ServiceRow;
  branchId: string;
  startAt: Date;
  status: AppointmentStatus;
  source: BookingSource;
  staffId: string;
  customerId: string | null;
  selection: "specific" | "any";
  preferredStaffId: string | null;
  holdExpiresAt: Date | null;
  note: string | null;
  idempotencyKey: string | null;
  createdByKind: "staff" | "customer" | "whatsapp" | "system";
  override?: Override | null;
  rescheduledFromId?: string | null;
  allocationReason?: string;
}

async function placeAppointment(tx: Tx, p: PlaceParams): Promise<string> {
  const endAt = addMinutes(p.startAt, p.service.duration_minutes);
  const rooms: (string | null)[] = p.service.requires_room
    ? (
        await tx.query<{ id: string }>("select id from rooms where branch_id = $1 and active order by name", [
          p.branchId,
        ])
      ).map((r) => r.id)
    : [null];
  if (rooms.length === 0) throw new AppError("ROOM_TAKEN", "No room is configured for this service.");
  let lastErr: unknown;
  for (const roomId of rooms) {
    try {
      return await tx.savepoint(async () => {
        if (p.allocationReason) await tx.setAuditReason(p.allocationReason);
        const a = await tx.one<{ id: string }>(
          `insert into appointments(organisation_id, branch_id, customer_id, service_id, kind, source, status, start_at, end_at,
              buffer_before_minutes, buffer_after_minutes, counts_toward_kpi, price_myr, room_id, staff_selection, preferred_staff_id,
              hold_expires_at, operational_note, idempotency_key, created_by, created_by_kind, rescheduled_from_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) returning id`,
          [
            tx.ctx.orgId,
            p.branchId,
            p.customerId,
            p.service.id,
            p.service.kind,
            p.source,
            p.status,
            p.startAt,
            endAt,
            p.service.buffer_before_minutes,
            p.service.buffer_after_minutes,
            p.service.counts_toward_kpi,
            p.service.price_myr,
            roomId,
            p.selection,
            p.preferredStaffId,
            p.holdExpiresAt,
            p.note,
            p.idempotencyKey,
            tx.ctx.userId ?? null,
            p.createdByKind,
            p.rescheduledFromId ?? null,
          ],
        );
        await tx.query(
          `insert into appointment_assignments(organisation_id, appointment_id, staff_id, origin, override_rules, override_reason, created_by)
           values ($1,$2,$3,'booking',$4,$5,$6)`,
          [
            tx.ctx.orgId,
            a.id,
            p.staffId,
            p.override?.rules ?? [],
            p.override?.reason ?? null,
            tx.ctx.userId ?? null,
          ],
        );
        if (p.allocationReason) await tx.setAuditReason(null);
        return a.id;
      });
    } catch (e) {
      lastErr = e;
      if (e instanceof AppError && e.code === "ROOM_TAKEN") continue; // try the next room
      throw e;
    }
  }
  throw lastErr;
}

/** Try each candidate staff member in order; first success wins. Surfaces the specific error when only one candidate. */
async function placeWithCandidates(
  tx: Tx,
  base: Omit<PlaceParams, "staffId" | "allocationReason">,
  candidates: { staffId: string; reason?: string }[],
): Promise<{ appointmentId: string; staffId: string }> {
  let last: unknown;
  for (const c of candidates) {
    try {
      const appointmentId = await placeAppointment(tx, {
        ...base,
        staffId: c.staffId,
        allocationReason: c.reason ? `auto-allocated: ${c.reason}` : undefined,
      });
      return { appointmentId, staffId: c.staffId };
    } catch (e) {
      last = e;
      if (!isCandidateConflict(e)) throw e;
    }
  }
  if (candidates.length > 1 || !last)
    throw new AppError("SLOT_TAKEN", "No masseuse is available at that time. Please choose another time.");
  throw last;
}

function assertBookableWindow(startAt: Date, now: Date, settings: Settings, enforce: boolean): void {
  if (!enforce) return;
  if (startAt < addMinutes(now, settings.booking.minNoticeMinutes))
    throw new AppError(
      "MIN_NOTICE",
      `Bookings need at least ${Math.round((settings.booking.minNoticeMinutes / 60) * 10) / 10} hour(s) notice.`,
    );
  if (startAt > addMinutes(now, settings.booking.maxAdvanceDays * 1440))
    throw new AppError(
      "MAX_ADVANCE",
      `Bookings can be made up to ${settings.booking.maxAdvanceDays} days ahead.`,
    );
}

// ---------------------------------------------------------------------------------------------
// 1) Customer flow: hold -> confirm
// ---------------------------------------------------------------------------------------------
export const holdInputSchema = z.object({
  branchId: z.uuid(),
  serviceId: z.uuid(),
  startAt: z.coerce.date(),
  staffId: z.union([z.uuid(), z.literal("any")]),
  source: z.enum(["web", "whatsapp"]).default("web"),
  idempotencyKey: z.string().min(8).max(128),
  customerId: z.uuid().optional(),
});
export type HoldInput = z.infer<typeof holdInputSchema>;

export interface HoldResult {
  holdId: string;
  holdToken: string;
  appointmentId: string;
  expiresAt: string;
  startAt: string;
  endAt: string;
  serviceName: string;
  staffId: string;
  staffName: string;
}

export async function createHold(
  orgId: string,
  raw: HoldInput,
  clock: Clock = systemClock,
): Promise<HoldResult> {
  const input = holdInputSchema.parse(raw);
  const actor: Actor = {
    kind: "customer",
    customerId: input.customerId ?? "",
    via: input.source === "whatsapp" ? "whatsapp" : "manage_token",
  };
  const stored = await withTx(ctxFor(orgId, actor), async (tx) => {
    const now = clock.now();
    await expireHolds(tx, now);
    return idempotent(tx, "hold", input.idempotencyKey, { ...input, idempotencyKey: undefined }, async () => {
      const [settings, service] = [await loadSettings(tx), await loadService(tx, input.serviceId)];
      await loadBranch(tx, input.branchId);
      if (!service.active || !service.online_bookable)
        throw new AppError("NOT_FOUND", "That service cannot be booked online.");
      if (service.branch_id && service.branch_id !== input.branchId)
        throw new AppError("NOT_FOUND", "Service not available at this branch.");
      assertBookableWindow(input.startAt, now, settings, true);

      const staff = await qualifiedStaff(
        tx,
        input.branchId,
        input.serviceId,
        input.staffId === "any" ? undefined : input.staffId,
      );
      if (staff.length === 0)
        throw new AppError("NOT_QUALIFIED", "That masseuse is not available for this service.");
      let preferred: string | null = null;
      if (input.customerId)
        preferred =
          (
            await tx.maybeOne<{ p: string | null }>(
              "select preferred_staff_id p from customers where id = $1",
              [input.customerId],
            )
          )?.p ?? null;
      const endAt = addMinutes(input.startAt, service.duration_minutes);
      const candidates =
        input.staffId === "any"
          ? (
              await rankStaff(
                tx,
                staff,
                {
                  startAt: input.startAt,
                  endAt,
                  serviceMinutes: service.duration_minutes,
                  preferredStaffId: preferred,
                  now,
                },
                settings,
              )
            ).map((r) => ({ staffId: r.staffId, reason: r.reason }))
          : [{ staffId: input.staffId }];

      const expiresAt = addMinutes(now, settings.booking.holdMinutes);
      const placed = await placeWithCandidates(
        tx,
        {
          service,
          branchId: input.branchId,
          startAt: input.startAt,
          status: "slot_held",
          source: input.source,
          customerId: null,
          selection: input.staffId === "any" ? "any" : "specific",
          preferredStaffId: input.staffId === "any" ? null : input.staffId,
          holdExpiresAt: expiresAt,
          note: null,
          idempotencyKey: null,
          createdByKind: input.source === "whatsapp" ? "whatsapp" : "customer",
        },
        candidates,
      );

      // The hold secret is derived from the hold id (HMAC), so the raw token is never stored and replays can re-issue it.
      const holdId = randomUUID();
      await tx.query(
        "insert into slot_holds(id, organisation_id, appointment_id, token_hash, expires_at, idempotency_key) values ($1,$2,$3,$4,$5,$6)",
        [
          holdId,
          orgId,
          placed.appointmentId,
          holdTokenHash(holdToken(holdId)),
          expiresAt,
          input.idempotencyKey,
        ],
      );
      const staffRow = staff.find((s) => s.id === placed.staffId);
      return {
        holdId,
        appointmentId: placed.appointmentId,
        expiresAt: expiresAt.toISOString(),
        startAt: input.startAt.toISOString(),
        endAt: endAt.toISOString(),
        serviceName: service.name,
        staffId: placed.staffId,
        staffName: staffRow?.display_name ?? "",
      } satisfies Omit<HoldResult, "holdToken">;
    });
  });
  return { ...stored, holdToken: holdToken(stored.holdId) };
}

export const confirmInputSchema = z.object({
  holdToken: z.string().min(20).max(200),
  customer: z.object({
    name: z.string().trim().min(1).max(100),
    phone: z.string().trim().min(6).max(30),
    email: z.string().trim().email().max(254).optional().or(z.literal("")),
  }),
  consent: z.object({
    serviceBooking: z.literal(true, { error: "Consent to process your booking is required" }),
    whatsapp: z.boolean(),
    marketing: z.boolean().default(false),
  }),
  noticeVersion: z.string().min(1).max(40),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().min(8).max(128),
});
export type ConfirmInput = z.infer<typeof confirmInputSchema>;

export interface ConfirmResult extends BookingSummary {
  manageToken: string;
}

export async function confirmHold(
  orgId: string,
  raw: ConfirmInput,
  clock: Clock = systemClock,
): Promise<ConfirmResult> {
  const input = confirmInputSchema.parse(raw);
  const holdId = verifySignedToken(input.holdToken, "hold");
  if (!holdId) throw new AppError("NOT_FOUND", "This booking session is not valid. Please start again.");
  const stored = await withTx(
    ctxFor(orgId, { kind: "customer", customerId: "", via: "manage_token" }),
    async (tx) =>
      idempotent(tx, "confirm", input.idempotencyKey, { ...input, idempotencyKey: undefined }, async () => {
        const row = await tx.maybeOne<{ appointment_id: string; status: string }>(
          "select appointment_id, status from slot_holds where id = $1 and token_hash = $2 for update",
          [holdId, holdTokenHash(input.holdToken)],
        );
        if (!row) throw new AppError("NOT_FOUND", "This booking session is not valid. Please start again.");
        const { appt } = await lockAppointment(tx, row.appointment_id);
        const now = clock.now();
        if (
          appt.status !== "slot_held" ||
          row.status !== "active" ||
          !appt.hold_expires_at ||
          appt.hold_expires_at <= now
        )
          throw new AppError("HOLD_EXPIRED", "Your reserved time has expired. Please choose a time again.");

        const settings = await loadSettings(tx);
        const customer = await upsertCustomer(
          tx,
          { name: input.customer.name, phone: input.customer.phone, email: input.customer.email || null },
          appt.source,
        );
        await recordConsents(
          tx,
          customer.id,
          { serviceBooking: true, whatsapp: input.consent.whatsapp, marketing: input.consent.marketing },
          input.noticeVersion,
          appt.source,
        );

        const status: AppointmentStatus = settings.booking.webRequiresApproval
          ? "pending_confirmation"
          : "confirmed";
        await tx.setStatusReason("customer confirmed hold");
        await tx.query(
          "update appointments set customer_id = $2, status = $3, hold_expires_at = null, operational_note = $4, idempotency_key = $5, updated_by = null where id = $1",
          [appt.id, customer.id, status, input.note || null, `confirm:${input.idempotencyKey}`],
        );
        await tx.query("update slot_holds set status = 'converted' where id = $1", [holdId]);

        const fresh: AppointmentRow = { ...appt, customer_id: customer.id, status };
        await afterBookingCreated(
          tx,
          fresh,
          settings,
          status === "confirmed" ? "booking_confirmed" : "booking_request_received",
        );
        return summarise(tx, appt.id);
      }),
  );
  return { ...stored, manageToken: manageToken(stored.appointmentId) };
}

/** Release a hold early (customer changed their mind). Idempotent. */
export async function releaseHold(orgId: string, holdTokenValue: string): Promise<void> {
  const holdId = verifySignedToken(holdTokenValue, "hold");
  if (!holdId) return;
  await withTx(ctxFor(orgId, { kind: "customer", customerId: "", via: "manage_token" }), async (tx) => {
    const row = await tx.maybeOne<{ appointment_id: string }>(
      "select appointment_id from slot_holds where id = $1 and token_hash = $2 and status = 'active' for update",
      [holdId, holdTokenHash(holdTokenValue)],
    );
    if (!row) return;
    await tx.setStatusReason("hold released by customer");
    await tx.query("update appointments set status = 'expired' where id = $1 and status = 'slot_held'", [
      row.appointment_id,
    ]);
    await tx.query("update slot_holds set status = 'released' where id = $1", [holdId]);
  });
}

async function afterBookingCreated(
  tx: Tx,
  appt: AppointmentRow,
  settings: Settings,
  purpose: "booking_confirmed" | "booking_request_received",
): Promise<void> {
  const staffId = (
    await tx.one<{ staff_id: string }>(
      "select staff_id from appointment_assignments where appointment_id = $1 and status = 'active'",
      [appt.id],
    )
  ).staff_id;
  await notifyBooking(tx, purpose, appt, "v1");
  await notifyStaff(tx, "assignment_new", staffId, appt, "v1");
  if (purpose === "booking_confirmed") {
    const remindAt = addMinutes(appt.start_at, -settings.booking.reminderHoursBefore * 60);
    if (remindAt > new Date()) await notifyBooking(tx, "appointment_reminder", appt, "v1", remindAt);
  }
}

// ---------------------------------------------------------------------------------------------
// 2) Staff flow: direct booking (telephone, walk-in, masseuse-recorded, manager)
// ---------------------------------------------------------------------------------------------
export const directInputSchema = z.object({
  branchId: z.uuid(),
  serviceId: z.uuid(),
  startAt: z.coerce.date(),
  staffId: z.union([z.uuid(), z.literal("any")]),
  source: z.enum(["phone", "walk_in", "staff_direct", "manager"]),
  customer: z.object({
    name: z.string().trim().min(1).max(100),
    phone: z.string().trim().min(6).max(30),
    email: z.string().trim().email().max(254).optional().or(z.literal("")),
  }),
  /** Staff confirm that the customer was informed of the privacy notice and agreed. */
  consent: z.object({
    serviceBooking: z.literal(true, { error: "Record the customer's consent to process their booking" }),
    whatsapp: z.boolean().default(false),
    marketing: z.boolean().default(false),
  }),
  noticeVersion: z.string().default("2026-01"),
  note: z.string().trim().max(500).optional(),
  override: overrideSchema.optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
});
export type DirectInput = z.infer<typeof directInputSchema>;

export async function createDirectBooking(
  principal: Principal,
  raw: DirectInput,
  clock: Clock = systemClock,
): Promise<BookingSummary & { manageToken: string }> {
  const input = directInputSchema.parse(raw);
  const actor: Actor = { kind: "staff", principal };

  // Authorisation (server-side; UI hiding is never relied upon)
  if (input.source === "staff_direct") {
    requirePermission(principal, "appointment.create.self");
    if (!principal.staffId) throw new AppError("FORBIDDEN", "Only masseuses can record direct bookings.");
    if (input.staffId !== principal.staffId)
      throw new AppError("FORBIDDEN", "You can only record bookings for yourself.");
  } else {
    requirePermission(principal, "appointment.create.any");
  }
  if (input.override) requirePermission(principal, "appointment.override");

  const stored = await withTx(ctxFor(principal.orgId, actor), async (tx) =>
    idempotent(tx, "direct", input.idempotencyKey, { ...input, idempotencyKey: undefined }, async () => {
      const now = clock.now();
      await expireHolds(tx, now);
      const [settings, service] = [await loadSettings(tx), await loadService(tx, input.serviceId)];
      await loadBranch(tx, input.branchId);
      if (!service.active) throw new AppError("NOT_FOUND", "Service is not active.");
      if (input.source === "staff_direct") {
        const ok = await tx.maybeOne<{ ok: boolean }>(
          "select can_take_direct_bookings ok from staff_profiles where id = $1",
          [principal.staffId],
        );
        if (!ok?.ok) throw new AppError("FORBIDDEN", "Direct booking is not enabled for your profile.");
      }
      const customer = await upsertCustomer(
        tx,
        { name: input.customer.name, phone: input.customer.phone, email: input.customer.email || null },
        input.source,
      );
      await recordConsents(
        tx,
        customer.id,
        { serviceBooking: true, whatsapp: input.consent.whatsapp, marketing: input.consent.marketing },
        input.noticeVersion,
        input.source,
      );

      const staff = await qualifiedStaff(
        tx,
        input.branchId,
        input.serviceId,
        input.staffId === "any" ? undefined : input.staffId,
      );
      if (staff.length === 0)
        throw new AppError("NOT_QUALIFIED", "That masseuse is not qualified for this service.");
      const endAt = addMinutes(input.startAt, service.duration_minutes);
      const pref =
        (
          await tx.maybeOne<{ p: string | null }>(
            "select preferred_staff_id p from customers where id = $1",
            [customer.id],
          )
        )?.p ?? null;
      const candidates =
        input.staffId === "any"
          ? (
              await rankStaff(
                tx,
                staff,
                {
                  startAt: input.startAt,
                  endAt,
                  serviceMinutes: service.duration_minutes,
                  preferredStaffId: pref,
                  now,
                },
                settings,
              )
            ).map((r) => ({ staffId: r.staffId, reason: r.reason }))
          : [{ staffId: input.staffId }];

      if (input.override) {
        await auditEvent(tx, {
          action: "booking.override_used",
          entityType: "appointments",
          data: { rules: input.override.rules },
          reason: input.override.reason,
        });
      }
      const placed = await placeWithCandidates(
        tx,
        {
          service,
          branchId: input.branchId,
          startAt: input.startAt,
          status: "confirmed",
          source: input.source,
          customerId: customer.id,
          selection: input.staffId === "any" ? "any" : "specific",
          preferredStaffId: input.staffId === "any" ? null : input.staffId,
          holdExpiresAt: null,
          note: input.note || null,
          idempotencyKey: input.idempotencyKey ? `direct:${input.idempotencyKey}` : null,
          createdByKind: "staff",
          override: input.override ?? null,
        },
        candidates,
      );
      const appt = await tx.one<AppointmentRow>("select * from appointments where id = $1", [
        placed.appointmentId,
      ]);
      await afterBookingCreated(tx, appt, settings, "booking_confirmed");
      return summarise(tx, appt.id);
    }),
  );
  return { ...stored, manageToken: manageToken(stored.appointmentId) };
}

// ---------------------------------------------------------------------------------------------
// 3) Authorisation helpers for changing an existing appointment
// ---------------------------------------------------------------------------------------------
async function assertActorMayChange(
  tx: Tx,
  actor: Actor,
  appt: AppointmentRow,
  staffId: string | null,
  settings: Settings,
  now: Date,
  action: "cancel" | "reschedule",
): Promise<void> {
  if (actor.kind === "system") return;
  if (actor.kind === "customer") {
    if (!appt.customer_id || appt.customer_id !== actor.customerId)
      throw new AppError("NOT_FOUND", "Booking not found."); // never reveal others' bookings
    if (!["pending_confirmation", "confirmed"].includes(appt.status))
      throw new AppError("NOT_ALLOWED", "This booking can no longer be changed online. Please contact us.");
    if (appt.start_at.getTime() - now.getTime() < settings.booking.changeCutoffHours * 3600_000)
      throw new AppError(
        "CANCELLATION_WINDOW",
        `Changes are free up to ${settings.booking.changeCutoffHours} hours before your appointment. Please contact us directly.`,
      );
    return;
  }
  const p = actor.principal;
  if (can(p, "appointment.transition.any")) return;
  void tx;
  void staffId;
  void action;
  throw new AppError(
    "FORBIDDEN",
    'Only a manager can cancel or move this appointment. Use "Request replacement" if you cannot attend.',
  );
}

async function cancelOpenReplacement(tx: Tx, appointmentId: string, why: string): Promise<void> {
  await tx.query(
    `update replacement_requests set status = 'cancelled', failure_reason = $2
      where appointment_id = $1 and status in ('awaiting_nominee','awaiting_nomination','awaiting_manager_approval')`,
    [appointmentId, why],
  );
}

// ---------------------------------------------------------------------------------------------
// 4) Cancel
// ---------------------------------------------------------------------------------------------
export async function cancelAppointment(
  orgId: string,
  actor: Actor,
  appointmentId: string,
  opts: { reason?: string } = {},
  clock: Clock = systemClock,
): Promise<BookingSummary> {
  return withTx(ctxFor(orgId, actor), async (tx) => {
    const { appt, assignment } = await lockAppointment(tx, appointmentId);
    const settings = await loadSettings(tx);
    const now = clock.now();
    await assertActorMayChange(tx, actor, appt, assignment?.staff_id ?? null, settings, now, "cancel");
    const to: AppointmentStatus =
      actor.kind === "customer" ? "cancelled_by_customer" : "cancelled_by_business";
    if (!canTransition(appt.status as AppointmentStatus, to))
      throw new AppError("INVALID_TRANSITION", "This appointment can no longer be cancelled.");
    await cancelOpenReplacement(tx, appt.id, "appointment cancelled");
    await tx.setStatusReason(opts.reason?.slice(0, 200) ?? null);
    await tx.query(
      "update appointments set status = $2, cancelled_at = $3, cancel_reason = $4, updated_by = $5 where id = $1",
      [appt.id, to, now, opts.reason?.slice(0, 200) ?? null, tx.ctx.userId ?? null],
    );
    await notifyBooking(tx, "booking_cancelled", appt, "v1");
    if (assignment) await notifyStaff(tx, "assignment_removed", assignment.staff_id, appt, "cancel");
    await offerFreedSlot(tx, appt);
    return summarise(tx, appt.id);
  });
}

/** Offer a freed slot to matching wait-list entries (one notification each; first come, first served is a business choice). */
async function offerFreedSlot(tx: Tx, appt: AppointmentRow): Promise<void> {
  const entries = await tx.query<{ id: string; customer_id: string }>(
    `select id, customer_id from waitlist_entries
      where organisation_id = $1 and branch_id = $2 and service_id = $3 and status = 'waiting'
        and window_start <= $4 and window_end >= $5 and (preferred_staff_id is null or preferred_staff_id = (
          select staff_id from appointment_assignments where appointment_id = $6 order by assigned_at desc limit 1))
      order by created_at limit 3`,
    [appt.organisation_id, appt.branch_id, appt.service_id, appt.start_at, appt.end_at, appt.id],
  );
  const tz = (
    await tx.one<{ timezone: string }>("select timezone from branches where id = $1", [appt.branch_id])
  ).timezone;
  for (const e of entries) {
    await tx.query("update waitlist_entries set status = 'offered', notified_at = now() where id = $1", [
      e.id,
    ]);
    const { enqueueNotification } = await import("./notifications");
    const { notificationParams } = await import("./booking-shared");
    await enqueueNotification(tx, {
      purpose: "waitlist_available",
      recipientKind: "customer",
      recipientId: e.customer_id,
      params: await notificationParams(tx, appt.id, tz),
      appointmentId: appt.id,
      dedupeKey: `waitlist:${e.id}:${appt.id}`,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// 5) Reschedule = new appointment + old marked "rescheduled" (history preserved, one transaction)
// ---------------------------------------------------------------------------------------------
export const rescheduleSchema = z.object({
  appointmentId: z.uuid(),
  newStartAt: z.coerce.date(),
  newStaffId: z.uuid().optional(),
  reason: z.string().trim().max(200).optional(),
  override: overrideSchema.optional(),
});
export type RescheduleInput = z.infer<typeof rescheduleSchema>;

export async function rescheduleAppointment(
  orgId: string,
  actor: Actor,
  raw: RescheduleInput,
  clock: Clock = systemClock,
): Promise<BookingSummary> {
  const input = rescheduleSchema.parse(raw);
  if (actor.kind === "staff") {
    requirePermission(actor.principal, "appointment.transition.any");
    if (input.override) requirePermission(actor.principal, "appointment.override");
  } else if (input.override || input.newStaffId) throw new AppError("FORBIDDEN", "Not allowed.");

  return withTx(ctxFor(orgId, actor), async (tx) => {
    const now = clock.now();
    await expireHolds(tx, now);
    const { appt, assignment } = await lockAppointment(tx, input.appointmentId);
    if (!assignment) throw new AppError("NOT_ALLOWED", "This appointment has no active assignment.");
    const settings = await loadSettings(tx);
    await assertActorMayChange(tx, actor, appt, assignment.staff_id, settings, now, "reschedule");
    if (appt.status !== "confirmed" && !(actor.kind === "staff" && appt.status === "pending_confirmation"))
      throw new AppError("INVALID_TRANSITION", "Only confirmed appointments can be rescheduled.");
    const service = await loadService(tx, appt.service_id);
    if (actor.kind === "customer") assertBookableWindow(input.newStartAt, now, settings, true);
    if (
      input.newStartAt.getTime() === appt.start_at.getTime() &&
      (!input.newStaffId || input.newStaffId === assignment.staff_id)
    )
      throw new AppError("VALIDATION", "Choose a different time.");

    const staffId = input.newStaffId ?? assignment.staff_id;
    // Release old slot first (same transaction) so the new time may overlap the old one.
    await cancelOpenReplacement(tx, appt.id, "appointment rescheduled");
    await tx.setStatusReason(input.reason ?? "rescheduled");
    await tx.query("update appointments set status = 'rescheduled', updated_by = $2 where id = $1", [
      appt.id,
      tx.ctx.userId ?? null,
    ]);
    if (input.override)
      await auditEvent(tx, {
        action: "booking.override_used",
        entityType: "appointments",
        entityId: appt.id,
        data: { rules: input.override.rules },
        reason: input.override.reason,
      });

    const newId = await placeAppointment(tx, {
      service,
      branchId: appt.branch_id,
      startAt: input.newStartAt,
      status: "confirmed",
      source: appt.source,
      staffId,
      customerId: appt.customer_id,
      selection: appt.staff_selection,
      preferredStaffId: appt.preferred_staff_id,
      holdExpiresAt: null,
      note: appt.operational_note,
      idempotencyKey: null,
      createdByKind: actor.kind === "staff" ? "staff" : "customer",
      override: input.override ?? null,
      rescheduledFromId: appt.id,
    });
    await tx.query("update appointments set rescheduled_to_id = $2 where id = $1", [appt.id, newId]);
    const fresh = await tx.one<AppointmentRow>("select * from appointments where id = $1", [newId]);
    await notifyBooking(tx, "booking_changed", fresh, "v1");
    const remindAt = addMinutes(fresh.start_at, -settings.booking.reminderHoursBefore * 60);
    if (remindAt > now) await notifyBooking(tx, "appointment_reminder", fresh, "v1", remindAt);
    await notifyStaff(tx, "assignment_new", staffId, fresh, "resched");
    if (staffId !== assignment.staff_id)
      await notifyStaff(tx, "assignment_removed", assignment.staff_id, appt, "resched");
    else await notifyStaff(tx, "assignment_removed", assignment.staff_id, appt, "resched-old"); // tells staff the old time is free
    return summarise(tx, newId);
  });
}

// ---------------------------------------------------------------------------------------------
// 6) Status transitions (check-in, in progress, complete, no-show, ...)
// ---------------------------------------------------------------------------------------------
const STAFF_OWN_TARGETS: AppointmentStatus[] = ["checked_in", "in_progress", "completed", "no_show"];

export async function transitionAppointment(
  orgId: string,
  principal: Principal,
  appointmentId: string,
  to: AppointmentStatus,
  opts: { reason?: string; actualMinutes?: number } = {},
  clock: Clock = systemClock,
): Promise<BookingSummary> {
  return withTx(ctxFor(orgId, { kind: "staff", principal }), async (tx) => {
    const { appt, assignment } = await lockAppointment(tx, appointmentId);
    const manager = can(principal, "appointment.transition.any");
    if (!manager) {
      requirePermission(principal, "appointment.transition.own");
      if (!assignment || assignment.staff_id !== principal.staffId)
        throw new AppError("NOT_FOUND", "Appointment not found.");
      if (!STAFF_OWN_TARGETS.includes(to))
        throw new AppError("FORBIDDEN", "Only a manager can make that change.");
    }
    if (
      to === "cancelled_by_customer" ||
      to === "cancelled_by_business" ||
      to === "rescheduled" ||
      to === "replacement_pending"
    )
      throw new AppError("NOT_ALLOWED", "Use the dedicated cancel, reschedule or replacement action.");
    if (!canTransition(appt.status as AppointmentStatus, to))
      throw new AppError("INVALID_TRANSITION", `Cannot change status from "${appt.status}" to "${to}".`);
    const now = clock.now();
    if ((to === "completed" || to === "no_show") && now < appt.start_at)
      throw new AppError("NOT_ALLOWED", "This appointment has not started yet.");
    if (
      opts.actualMinutes !== undefined &&
      (to !== "completed" || opts.actualMinutes < 1 || opts.actualMinutes > 720)
    )
      throw new AppError("VALIDATION", "Actual minutes can only be recorded when completing (1-720).");

    await tx.setStatusReason(opts.reason?.slice(0, 200) ?? null);
    await tx.query(
      `update appointments set status = $2, updated_by = $3,
         checked_in_at = case when $2 = 'checked_in' then $4 else checked_in_at end,
         started_at = case when $2 = 'in_progress' then $4 else started_at end,
         completed_at = case when $2 = 'completed' then $4 else completed_at end,
         actual_minutes = case when $2 = 'completed' then $5 else actual_minutes end
       where id = $1`,
      [appt.id, to, principal.userId, now, opts.actualMinutes ?? null],
    );
    return summarise(tx, appt.id);
  });
}

// ---------------------------------------------------------------------------------------------
// 7) Manager reassignment (not a replacement request: the manager decides directly)
// ---------------------------------------------------------------------------------------------
export const reassignSchema = z.object({
  appointmentId: z.uuid(),
  newStaffId: z.uuid(),
  reason: z.string().trim().min(3).max(200),
  override: overrideSchema.optional(),
});

/** Swap the active assignment atomically, keeping history. Used by manager reassignment and replacement approval. */
export async function swapAssignment(
  tx: Tx,
  appt: AppointmentRow,
  oldAssignmentId: string,
  newStaffId: string,
  origin: "manager_reassign" | "replacement",
  opts: { replacementRequestId?: string; override?: Override | null } = {},
): Promise<string> {
  await tx.query(
    "update appointment_assignments set status = 'superseded', released_at = now() where id = $1 and status = 'active'",
    [oldAssignmentId],
  );
  const row = await tx.one<{ id: string }>(
    `insert into appointment_assignments(organisation_id, appointment_id, staff_id, origin, replacement_request_id, override_rules, override_reason, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [
      tx.ctx.orgId,
      appt.id,
      newStaffId,
      origin,
      opts.replacementRequestId ?? null,
      opts.override?.rules ?? [],
      opts.override?.reason ?? null,
      tx.ctx.userId ?? null,
    ],
  );
  return row.id;
}

export async function reassignAppointment(
  principal: Principal,
  raw: z.infer<typeof reassignSchema>,
): Promise<BookingSummary> {
  const input = reassignSchema.parse(raw);
  requirePermission(principal, "appointment.assign");
  if (input.override) requirePermission(principal, "appointment.override");
  return withTx(ctxFor(principal.orgId, { kind: "staff", principal }), async (tx) => {
    const { appt, assignment } = await lockAppointment(tx, input.appointmentId);
    if (!assignment) throw new AppError("NOT_ALLOWED", "This appointment has no active assignment.");
    if (!["pending_confirmation", "confirmed"].includes(appt.status))
      throw new AppError(
        "INVALID_TRANSITION",
        "Only pending or confirmed appointments can be reassigned. Resolve any replacement request first.",
      );
    if (assignment.staff_id === input.newStaffId)
      throw new AppError("VALIDATION", "Choose a different masseuse.");
    await tx.setAuditReason(input.reason);
    await swapAssignment(tx, appt, assignment.id, input.newStaffId, "manager_reassign", {
      override: input.override,
    });
    await notifyStaff(tx, "assignment_new", input.newStaffId, appt, "reassign");
    await notifyStaff(tx, "assignment_removed", assignment.staff_id, appt, "reassign");
    await notifyBooking(tx, "booking_changed", appt, `reassign-${input.newStaffId}`);
    return summarise(tx, appt.id);
  });
}

// ---------------------------------------------------------------------------------------------
// 8) Wait-list
// ---------------------------------------------------------------------------------------------
export const waitlistSchema = z.object({
  branchId: z.uuid(),
  serviceId: z.uuid(),
  preferredStaffId: z.uuid().optional(),
  windowStart: z.coerce.date(),
  windowEnd: z.coerce.date(),
  customer: z.object({ name: z.string().trim().min(1).max(100), phone: z.string().trim().min(6).max(30) }),
  consent: z.object({ serviceBooking: z.literal(true), whatsapp: z.boolean() }),
  noticeVersion: z.string().default("2026-01"),
});
export async function joinWaitlist(
  orgId: string,
  raw: z.infer<typeof waitlistSchema>,
): Promise<{ id: string }> {
  const input = waitlistSchema.parse(raw);
  if (input.windowEnd <= input.windowStart) throw new AppError("VALIDATION", "Choose a valid time range.");
  return withTx(ctxFor(orgId, { kind: "customer", customerId: "", via: "manage_token" }), async (tx) => {
    const c = await upsertCustomer(tx, input.customer, "web");
    await recordConsents(
      tx,
      c.id,
      { serviceBooking: true, whatsapp: input.consent.whatsapp },
      input.noticeVersion,
      "web",
    );
    return tx.one<{ id: string }>(
      `insert into waitlist_entries(organisation_id, branch_id, customer_id, service_id, preferred_staff_id, window_start, window_end)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [
        orgId,
        input.branchId,
        c.id,
        input.serviceId,
        input.preferredStaffId ?? null,
        input.windowStart,
        input.windowEnd,
      ],
    );
  });
}

export { minutesBetween, newToken };
export type { CustomerInput };
