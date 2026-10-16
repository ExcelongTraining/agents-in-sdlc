import type { Tx } from "../db/tx";
import { AppError } from "../errors";
import { computeSlots, groupByStart, type AvailabilityInput, type GroupedSlot, type Slot } from "../domain/availability";
import { addMinutes, startOfLocalDay } from "../domain/time";
import { loadSettings } from "./settings";

export interface ServiceRow {
  id: string;
  organisation_id: string;
  branch_id: string | null;
  name: string;
  kind: "service" | "trial" | "consultation";
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  price_myr: number | null;
  counts_toward_kpi: boolean;
  requires_room: boolean;
  online_bookable: boolean;
  active: boolean;
}

export async function loadService(tx: Tx, serviceId: string): Promise<ServiceRow> {
  const s = await tx.maybeOne<ServiceRow>("select * from services where id = $1 and organisation_id = $2", [serviceId, tx.ctx.orgId]);
  if (!s) throw new AppError("NOT_FOUND", "Service not found.");
  return s;
}

export async function loadBranch(tx: Tx, branchId: string): Promise<{ id: string; name: string; timezone: string }> {
  const b = await tx.maybeOne<{ id: string; name: string; timezone: string }>(
    "select id, name, timezone from branches where id = $1 and organisation_id = $2 and active", [branchId, tx.ctx.orgId]);
  if (!b) throw new AppError("NOT_FOUND", "Branch not found.");
  return b;
}

export interface StaffRef {
  id: string;
  display_name: string;
}

/** Active staff in the branch who are qualified for the service. */
export async function qualifiedStaff(tx: Tx, branchId: string, serviceId: string, onlyStaffId?: string): Promise<StaffRef[]> {
  return tx.query<StaffRef>(
    `select sp.id, sp.display_name from staff_profiles sp join staff_services ss on ss.staff_id = sp.id
      where sp.organisation_id = $1 and sp.branch_id = $2 and sp.active and sp.archived_at is null
        and ss.service_id = $3 and ($4::uuid is null or sp.id = $4)
      order by sp.display_name`,
    [tx.ctx.orgId, branchId, serviceId, onlyStaffId ?? null],
  );
}

export interface AvailabilityQuery {
  branchId: string;
  serviceId: string;
  fromDate: string; // yyyy-MM-dd local
  toDate: string;
  staffId?: string;
  now: Date;
  /** Customer-facing searches enforce minimum notice and maximum advance; staff searches do not. */
  enforceNotice: boolean;
  /** Public flows only offer online-bookable services. */
  publicOnly?: boolean;
}

export async function loadAvailabilityInput(tx: Tx, q: AvailabilityQuery): Promise<AvailabilityInput & { staffNames: Map<string, string> }> {
  const [service, branch, settings] = await Promise.all([loadService(tx, q.serviceId), loadBranch(tx, q.branchId), loadSettings(tx)]);
  if (!service.active || (q.publicOnly && !service.online_bookable)) throw new AppError("NOT_FOUND", "Service not available.");
  if (service.branch_id && service.branch_id !== q.branchId) throw new AppError("NOT_FOUND", "Service not available at this branch.");

  const staff = await qualifiedStaff(tx, q.branchId, q.serviceId, q.staffId);
  const staffIds = staff.map((s) => s.id);
  const rangeStart = startOfLocalDay(q.fromDate, branch.timezone);
  const rangeEnd = addMinutes(startOfLocalDay(q.toDate, branch.timezone), 24 * 60);
  // widen so buffers/overlaps at the edges are seen
  const lo = addMinutes(rangeStart, -24 * 60);
  const hi = addMinutes(rangeEnd, 24 * 60);

  const [hours, business, exceptions, busy, rooms, roomBusy] = await Promise.all([
    tx.query<{ staff_id: string; weekday: number; start_time: string; end_time: string }>(
      "select staff_id, weekday, start_time::text, end_time::text from staff_working_hours where status = 'approved' and staff_id = any($1)", [staffIds]),
    tx.query<{ weekday: number; open_time: string; close_time: string }>(
      "select weekday, open_time::text, close_time::text from business_hours where branch_id = $1", [q.branchId]),
    tx.query<{ staff_id: string | null; s: Date; e: Date }>(
      `select staff_id, lower(period) s, upper(period) e from availability_exceptions
        where status = 'approved' and period && tstzrange($3, $4, '[)')
          and ((staff_id = any($1)) or (staff_id is null and branch_id = $2))`, [staffIds, q.branchId, lo, hi]),
    tx.query<{ staff_id: string; s: Date; e: Date }>(
      "select staff_id, lower(occupied) s, upper(occupied) e from appointment_assignments where status = 'active' and staff_id = any($1) and occupied && tstzrange($2, $3, '[)')",
      [staffIds, lo, hi]),
    service.requires_room ? tx.query<{ id: string }>("select id from rooms where branch_id = $1 and active order by name", [q.branchId]) : Promise.resolve([]),
    service.requires_room
      ? tx.query<{ room_id: string; s: Date; e: Date }>(
          `select room_id, lower(occupied) s, upper(occupied) e from appointments
            where branch_id = $1 and room_id is not null and occupied && tstzrange($2, $3, '[)')
              and status in ('slot_held','pending_confirmation','confirmed','checked_in','in_progress','completed','replacement_pending')`,
          [q.branchId, lo, hi])
      : Promise.resolve([]),
  ]);

  // Holds that have expired but have not been swept yet must not block availability.
  const staleHolds = await tx.query<{ staff_id: string; s: Date; e: Date }>(
    `select g.staff_id, lower(g.occupied) s, upper(g.occupied) e from appointment_assignments g join appointments a on a.id = g.appointment_id
      where g.status = 'active' and a.status = 'slot_held' and a.hold_expires_at <= $2 and g.staff_id = any($1)`, [staffIds, q.now]);
  const staleKey = new Set(staleHolds.map((h) => `${h.staff_id}|${h.s.getTime()}|${h.e.getTime()}`));

  return {
    tz: branch.timezone,
    fromDate: q.fromDate,
    toDate: q.toDate,
    now: q.now,
    service: {
      durationMinutes: service.duration_minutes,
      bufferBeforeMinutes: service.buffer_before_minutes,
      bufferAfterMinutes: service.buffer_after_minutes,
      requiresRoom: service.requires_room,
    },
    businessHours: business.map((b) => ({ weekday: b.weekday, start: b.open_time, end: b.close_time })),
    staff: staff.map((s) => ({
      staffId: s.id,
      workingHours: hours.filter((h) => h.staff_id === s.id).map((h) => ({ weekday: h.weekday, start: h.start_time, end: h.end_time })),
    })),
    exceptions: exceptions.map((e) => ({ staffId: e.staff_id, start: e.s, end: e.e })),
    busy: busy.filter((b) => !staleKey.has(`${b.staff_id}|${b.s.getTime()}|${b.e.getTime()}`)).map((b) => ({ staffId: b.staff_id, start: b.s, end: b.e })),
    rooms: rooms.map((r) => r.id),
    roomBusy: roomBusy.map((r) => ({ roomId: r.room_id, start: r.s, end: r.e })),
    rules: {
      stepMinutes: settings.booking.slotStepMinutes,
      minNoticeMinutes: settings.booking.minNoticeMinutes,
      maxAdvanceDays: settings.booking.maxAdvanceDays,
      enforceNotice: q.enforceNotice,
    },
    staffNames: new Map(staff.map((s) => [s.id, s.display_name])),
  };
}

export async function searchSlots(tx: Tx, q: AvailabilityQuery): Promise<{ slots: Slot[]; grouped: GroupedSlot[]; staffNames: Map<string, string> }> {
  const input = await loadAvailabilityInput(tx, q);
  const slots = computeSlots(input);
  return { slots, grouped: groupByStart(slots), staffNames: input.staffNames };
}
