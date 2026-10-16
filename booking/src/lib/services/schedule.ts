import { z } from "zod";
import { withTx, type DbContext } from "../db/tx";
import { AppError } from "../errors";
import { can, requirePermission, type Principal } from "../domain/rbac";
import { maskPhone } from "../domain/phone";

export const staffCtx = (p: Principal): DbContext => ({
  kind: "staff",
  orgId: p.orgId,
  userId: p.userId,
  staffId: p.staffId,
  roles: p.roles,
});

export const rangeSchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  staffId: z.uuid().optional(),
});

export interface ScheduleItem {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
  kind: string;
  source: string;
  serviceName: string;
  staffId: string | null;
  staffName: string | null;
  customerName: string | null;
  customerPhone: string | null; // full for managers, masked for masseuses
  note: string | null;
  isNew: boolean; // newly assigned and not yet seen by the masseuse
  replacementPending: boolean;
}

/**
 * Schedule reads run under the RLS-enforced staff role: a masseuse's query physically cannot return other people's
 * appointments, whatever filter is passed. Managers see everything.
 */
export async function listSchedule(
  principal: Principal,
  raw: z.input<typeof rangeSchema>,
): Promise<ScheduleItem[]> {
  const q = rangeSchema.parse(raw);
  if (q.to.getTime() - q.from.getTime() > 93 * 86400_000)
    throw new AppError("VALIDATION", "Choose a range of at most 3 months.");
  if (!can(principal, "schedule.read.all")) requirePermission(principal, "schedule.read.own");
  const manager = can(principal, "schedule.read.all");
  const rows = await withTx(staffCtx(principal), (tx) =>
    tx.query<{
      id: string;
      start_at: Date;
      end_at: Date;
      status: string;
      kind: string;
      source: string;
      service_name: string;
      staff_id: string | null;
      staff_name: string | null;
      customer_name: string | null;
      phone_e164: string | null;
      operational_note: string | null;
      acknowledged_at: Date | null;
      assigned_at: Date;
    }>(
      `select a.id, a.start_at, a.end_at, a.status, a.kind, a.source, s.name service_name, sp.id staff_id, sp.display_name staff_name,
              c.display_name customer_name, c.phone_e164, a.operational_note, g.acknowledged_at, g.assigned_at
         from appointments a join services s on s.id = a.service_id
         left join appointment_assignments g on g.appointment_id = a.id and g.status = 'active'
         left join staff_profiles sp on sp.id = g.staff_id
         left join customers c on c.id = a.customer_id
        where a.start_at < $2 and a.end_at > $1 and ($3::uuid is null or g.staff_id = $3)
          and a.status not in ('draft','expired','rescheduled','slot_held')
        order by a.start_at limit 2000`,
      [q.from, q.to, q.staffId ?? null],
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    startAt: r.start_at.toISOString(),
    endAt: r.end_at.toISOString(),
    status: r.status,
    kind: r.kind,
    source: r.source,
    serviceName: r.service_name,
    staffId: r.staff_id,
    staffName: r.staff_name,
    customerName: r.customer_name
      ? manager
        ? r.customer_name
        : (r.customer_name.split(" ")[0] ?? r.customer_name)
      : null,
    customerPhone: manager ? r.phone_e164 : maskPhone(r.phone_e164),
    note: r.operational_note,
    isNew:
      !!principal.staffId &&
      r.staff_id === principal.staffId &&
      r.acknowledged_at === null &&
      r.assigned_at.getTime() > Date.now() - 7 * 86400_000 &&
      r.source !== "staff_direct",
    replacementPending: r.status === "replacement_pending",
  }));
}

/** The masseuse has seen her new assignments: clears the "new" indicator. */
export async function acknowledgeAssignments(principal: Principal): Promise<number> {
  requirePermission(principal, "schedule.read.own");
  if (!principal.staffId) return 0;
  const rows = await withTx(staffCtx(principal), (tx) =>
    tx.query(
      "update appointment_assignments set acknowledged_at = now() where staff_id = $1 and status = 'active' and acknowledged_at is null returning id",
      [principal.staffId],
    ),
  );
  return rows.length;
}

export interface ManagerDashboard {
  todayCount: number;
  pendingConfirmation: number;
  openReplacements: {
    id: string;
    status: string;
    appointmentId: string;
    requester: string;
    nominee: string | null;
    startAt: string;
    reason: string;
  }[];
  unacknowledged: number;
  failedNotifications: number;
  deadLetters: number;
  humanHandoffs: number;
  activeHolds: number;
  staffToday: { staffId: string; name: string; appointments: number; onLeave: boolean }[];
}

export async function managerDashboard(
  principal: Principal,
  dayStart: Date,
  dayEnd: Date,
): Promise<ManagerDashboard> {
  requirePermission(principal, "schedule.read.all");
  return withTx(staffCtx(principal), async (tx) => {
    const n = async (sql: string, p: unknown[] = []) => Number((await tx.one<{ n: number }>(sql, p)).n);
    const todayCount = await n(
      "select count(*) n from appointments where start_at >= $1 and start_at < $2 and status in ('confirmed','checked_in','in_progress','completed','replacement_pending','pending_confirmation')",
      [dayStart, dayEnd],
    );
    const pendingConfirmation = await n(
      "select count(*) n from appointments where status = 'pending_confirmation' and start_at > now()",
    );
    const unacknowledged = await n(
      "select count(*) n from appointment_assignments g join appointments a on a.id = g.appointment_id where g.status = 'active' and g.acknowledged_at is null and g.assigned_at < now() - interval '1 hour' and a.start_at > now() and a.status in ('confirmed','pending_confirmation')",
    );
    const failedNotifications = await n("select count(*) n from notification_jobs where status = 'failed'");
    const deadLetters = await n(
      "select count(*) n from notification_jobs where status = 'dead' and created_at > now() - interval '7 days'",
    );
    const humanHandoffs = await n(
      "select count(*) n from whatsapp_conversations where handoff_status = 'requested'",
    );
    const activeHolds = await n(
      "select count(*) n from appointments where status = 'slot_held' and hold_expires_at > now()",
    );
    const openReplacements = (
      await tx.query<{
        id: string;
        status: string;
        appointment_id: string;
        requester: string;
        nominee: string | null;
        start_at: Date;
        reason: string;
      }>(
        `select r.id, r.status, r.appointment_id, rq.display_name requester, nm.display_name nominee, r.starts_at start_at, r.reason
         from replacement_requests r join staff_profiles rq on rq.id = r.requested_by_staff_id
         left join staff_profiles nm on nm.id = r.nominee_staff_id
        where r.status in ('awaiting_nominee','awaiting_nomination','awaiting_manager_approval') order by r.starts_at`,
      )
    ).map((r) => ({
      id: r.id,
      status: r.status,
      appointmentId: r.appointment_id,
      requester: r.requester,
      nominee: r.nominee,
      startAt: r.start_at.toISOString(),
      reason: r.reason,
    }));
    const staffToday = (
      await tx.query<{ id: string; name: string; c: number; leave: boolean }>(
        `select sp.id, sp.display_name name,
              (select count(*) from appointment_assignments g join appointments a on a.id = g.appointment_id
                where g.staff_id = sp.id and g.status = 'active' and a.start_at >= $1 and a.start_at < $2)::int c,
              exists (select 1 from availability_exceptions e where e.staff_id = sp.id and e.status = 'approved' and e.kind in ('leave','blocked','training') and e.period && tstzrange($1,$2)) leave
         from staff_profiles sp where sp.active and sp.archived_at is null order by sp.display_name`,
        [dayStart, dayEnd],
      )
    ).map((r) => ({ staffId: r.id, name: r.name, appointments: r.c, onLeave: r.leave }));
    return {
      todayCount,
      pendingConfirmation,
      openReplacements,
      unacknowledged,
      failedNotifications,
      deadLetters,
      humanHandoffs,
      activeHolds,
      staffToday,
    };
  });
}

export async function listStaff(
  principal: Principal,
): Promise<{ id: string; name: string; active: boolean }[]> {
  return withTx(staffCtx(principal), (tx) =>
    tx.query<{ id: string; name: string; active: boolean }>(
      "select id, display_name name, active from staff_profiles where archived_at is null order by display_name",
    ),
  );
}

export async function listMyReplacements(principal: Principal) {
  requirePermission(principal, "replacement.respond");
  return withTx(staffCtx(principal), (tx) =>
    tx.query<{
      id: string;
      status: string;
      appointment_id: string;
      start_at: Date;
      service: string;
      reason: string;
      direction: "incoming" | "outgoing";
    }>(
      `select r.id, r.status, r.appointment_id, r.starts_at start_at, r.service_name service, r.reason,
              case when r.nominee_staff_id = $1 then 'incoming' else 'outgoing' end direction
         from replacement_requests r
        where (r.nominee_staff_id = $1 or r.requested_by_staff_id = $1) and r.status in ('awaiting_nominee','awaiting_nomination','awaiting_manager_approval')
        order by r.starts_at`,
      [principal.staffId],
    ),
  );
}
