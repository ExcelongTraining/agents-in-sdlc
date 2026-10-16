import { z } from "zod";
import { randomUUID } from "node:crypto";
import { withTx } from "../db/tx";
import { AppError } from "../errors";
import { can, requirePermission, type Principal } from "../domain/rbac";
import { ctxFor } from "./booking";
import { staffCtx } from "./schedule";
import { notifyManagers } from "./notifications";

export const exceptionSchema = z.object({
  staffId: z.uuid().nullable().optional(),
  kind: z.enum(["break", "leave", "blocked", "training", "internal", "closure"]),
  start: z.coerce.date(),
  end: z.coerce.date(),
  reason: z.string().trim().max(200).optional(),
});

/**
 * Masseuses REQUEST time off (pending, no effect on bookings until approved). Managers create approved entries
 * directly; the database refuses to approve one that overlaps an existing booking.
 */
export async function createException(
  principal: Principal,
  raw: z.input<typeof exceptionSchema>,
): Promise<{ id: string; status: string }> {
  const input = exceptionSchema.parse(raw);
  if (input.end <= input.start) throw new AppError("VALIDATION", "The end must be after the start.");
  const manager = can(principal, "availability.manage.all");
  if (!manager) {
    requirePermission(principal, "availability.request.own");
    if (!principal.staffId || (input.staffId && input.staffId !== principal.staffId))
      throw new AppError("FORBIDDEN", "You can only request time off for yourself.");
    if (!["leave", "break", "blocked"].includes(input.kind))
      throw new AppError("FORBIDDEN", "Only a manager can create that kind of entry.");
  }
  const staffId = manager ? (input.staffId ?? null) : principal.staffId;
  if (!staffId && input.kind !== "closure" && input.kind !== "blocked")
    throw new AppError("VALIDATION", "Choose a staff member.");
  const status = manager ? "approved" : "pending";
  return withTx(staffCtx(principal), async (tx) => {
    const branch = staffId
      ? await tx.one<{ branch_id: string }>("select branch_id from staff_profiles where id = $1", [staffId])
      : await tx.one<{ branch_id: string }>(
          "select id branch_id from branches where organisation_id = $1 and active order by created_at limit 1",
          [principal.orgId],
        );
    const row = await tx.one<{ id: string }>(
      `insert into availability_exceptions(organisation_id, branch_id, staff_id, kind, period, reason, status, requested_by, created_by, decided_by, decided_at)
       values ($1,$2,$3,$4,tstzrange($5,$6,'[)'),$7,$8,$9,$9,$10,$11) returning id`,
      [
        principal.orgId,
        branch.branch_id,
        staffId,
        input.kind,
        input.start,
        input.end,
        input.reason ?? null,
        status,
        principal.userId,
        manager ? principal.userId : null,
        manager ? new Date() : null,
      ],
    );
    if (!manager)
      await notifyManagers(
        tx,
        "manager_approval_required",
        { date: input.start.toISOString().slice(0, 10), time: "leave request" },
        null,
        `exc:${row.id}`,
      );
    return { id: row.id, status };
  });
}

export async function decideException(
  principal: Principal,
  id: string,
  approve: boolean,
): Promise<{ status: string }> {
  requirePermission(principal, "availability.approve");
  return withTx(ctxFor(principal.orgId, { kind: "staff", principal }), async (tx) => {
    const e = await tx.maybeOne<{ status: string; staff_id: string | null }>(
      "select status, staff_id from availability_exceptions where id = $1 for update",
      [id],
    );
    if (!e) throw new AppError("NOT_FOUND", "Request not found.");
    if (e.status !== "pending")
      throw new AppError("INVALID_TRANSITION", "This request has already been decided.");
    const status = approve ? "approved" : "rejected";
    // Approval fires the database check: it fails (BK007) if the period overlaps an existing booking.
    await tx.query(
      "update availability_exceptions set status = $2, decided_by = $3, decided_at = now(), updated_by = $3 where id = $1",
      [id, status, principal.userId],
    );
    return { status };
  });
}

export async function cancelException(principal: Principal, id: string): Promise<void> {
  await withTx(staffCtx(principal), async (tx) => {
    const r = await tx.query(
      "update availability_exceptions set status = 'cancelled', updated_by = $2 where id = $1 and status in ('pending','approved') returning id",
      [id, principal.userId],
    );
    if (r.length === 0) throw new AppError("NOT_FOUND", "Entry not found.");
  });
}

export const hoursSchema = z.object({
  staffId: z.uuid().optional(),
  windows: z
    .array(
      z.object({
        weekday: z.number().int().min(1).max(7),
        start: z.string().regex(/^\d{2}:\d{2}$/),
        end: z.string().regex(/^\d{2}:\d{2}$/),
      }),
    )
    .max(28),
});

/** A change to a staff member's weekly hours: instant for managers, pending approval when proposed by the staff member. */
export async function proposeWorkingHours(
  principal: Principal,
  raw: z.input<typeof hoursSchema>,
): Promise<{ batchId: string; status: string }> {
  const input = hoursSchema.parse(raw);
  const manager = can(principal, "availability.manage.all");
  const staffId = manager ? input.staffId : principal.staffId;
  if (!manager) {
    requirePermission(principal, "availability.request.own");
    if (input.staffId && input.staffId !== principal.staffId)
      throw new AppError("FORBIDDEN", "You can only change your own hours.");
  }
  if (!staffId) throw new AppError("VALIDATION", "Choose a staff member.");
  for (const w of input.windows)
    if (w.end <= w.start) throw new AppError("VALIDATION", "Each end time must be after its start time.");
  const batchId = randomUUID();
  const status = manager ? "approved" : "pending";
  return withTx(staffCtx(principal), async (tx) => {
    if (manager)
      await tx.query(
        "update staff_working_hours set status = 'superseded' where staff_id = $1 and status = 'approved'",
        [staffId],
      );
    for (const w of input.windows) {
      await tx.query(
        "insert into staff_working_hours(organisation_id, staff_id, weekday, start_time, end_time, status, batch_id, requested_by, decided_by, decided_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          principal.orgId,
          staffId,
          w.weekday,
          w.start,
          w.end,
          status,
          batchId,
          principal.userId,
          manager ? principal.userId : null,
          manager ? new Date() : null,
        ],
      );
    }
    if (!manager)
      await notifyManagers(
        tx,
        "manager_approval_required",
        { date: "hours", time: "change request" },
        null,
        `hours:${batchId}`,
      );
    return { batchId, status };
  });
}

export async function decideWorkingHours(
  principal: Principal,
  batchId: string,
  approve: boolean,
): Promise<{ status: string; futureBookingsOutsideNewHours: number }> {
  requirePermission(principal, "availability.approve");
  return withTx(ctxFor(principal.orgId, { kind: "staff", principal }), async (tx) => {
    const rows = await tx.query<{ staff_id: string }>(
      "select distinct staff_id from staff_working_hours where batch_id = $1 and status = 'pending'",
      [batchId],
    );
    const staffId = rows[0]?.staff_id;
    if (!staffId) throw new AppError("NOT_FOUND", "Request not found or already decided.");
    if (!approve) {
      await tx.query(
        "update staff_working_hours set status = 'rejected', decided_by = $2, decided_at = now() where batch_id = $1",
        [batchId, principal.userId],
      );
      return { status: "rejected", futureBookingsOutsideNewHours: 0 };
    }
    await tx.query(
      "update staff_working_hours set status = 'superseded' where staff_id = $1 and status = 'approved'",
      [staffId],
    );
    await tx.query(
      "update staff_working_hours set status = 'approved', decided_by = $2, decided_at = now() where batch_id = $1",
      [batchId, principal.userId],
    );
    // Existing bookings are not cancelled by a change of hours; tell the manager how many now fall outside so they can reassign.
    const out = await tx.one<{ n: number }>(
      `select count(*)::int n from appointment_assignments g join appointments a on a.id = g.appointment_id join branches b on b.id = a.branch_id
        where g.staff_id = $1 and g.status = 'active' and a.start_at > now() and a.status in ('confirmed','pending_confirmation')
          and not exists (select 1 from staff_working_hours w where w.staff_id = g.staff_id and w.status = 'approved'
               and w.weekday = extract(isodow from a.start_at at time zone b.timezone)::int
               and w.start_time <= (a.start_at at time zone b.timezone)::time and w.end_time >= (a.end_at at time zone b.timezone)::time)`,
      [staffId],
    );
    return { status: "approved", futureBookingsOutsideNewHours: out.n };
  });
}

export async function listPendingAvailability(principal: Principal) {
  requirePermission(principal, "availability.approve");
  return withTx(staffCtx(principal), async (tx) => ({
    exceptions: await tx.query<{
      id: string;
      staff: string;
      kind: string;
      start: Date;
      end: Date;
      reason: string | null;
    }>(
      `select e.id, sp.display_name staff, e.kind, lower(e.period) start, upper(e.period) "end", e.reason from availability_exceptions e
         left join staff_profiles sp on sp.id = e.staff_id where e.status = 'pending' order by lower(e.period)`,
    ),
    hours: await tx.query<{
      batch_id: string;
      staff: string;
      weekday: number;
      start_time: string;
      end_time: string;
    }>(
      `select w.batch_id, sp.display_name staff, w.weekday, w.start_time::text, w.end_time::text from staff_working_hours w
         join staff_profiles sp on sp.id = w.staff_id where w.status = 'pending' order by w.batch_id, w.weekday`,
    ),
  }));
}
