import type { Tx } from "../db/tx";
import { withTx } from "../db/tx";
import { AppError } from "../errors";
import { can, type Principal } from "../domain/rbac";
import { availableMinutes, computeMetric, pace, progress, type HoursBasis, type KpiMetric, type MetricResult, type Pace, type Progress, type WorkRecord } from "../domain/kpi";
import { periodBounds, type KpiPeriod } from "../domain/time";
import { loadSettings } from "./settings";

interface CreditedRow {
  appointment_id: string; staff_id: string; origin: WorkRecord["origin"]; customer_id: string | null; status: string;
  kind: WorkRecord["kind"]; counts_toward_kpi: boolean; start_at: Date; sched: number; actual_minutes: number | null; first_visit: boolean;
}

/**
 * Appointments in [from, to) each credited to exactly ONE staff member: the active assignment, or for
 * cancelled/no-show appointments the most recent non-superseded one. Superseded (replaced) assignments never count.
 */
export async function loadWorkRecords(tx: Tx, from: Date, to: Date, staffId?: string): Promise<WorkRecord[]> {
  const rows = await tx.query<CreditedRow>(
    `select distinct on (a.id) a.id appointment_id, g.staff_id, g.origin, a.customer_id, a.status, a.kind, a.counts_toward_kpi, a.start_at,
            extract(epoch from (a.end_at - a.start_at)) / 60 sched, a.actual_minutes,
            not exists (select 1 from appointments p where p.customer_id = a.customer_id and p.status = 'completed' and p.id <> a.id
                           and (p.start_at < a.start_at or (p.start_at = a.start_at and p.id < a.id))) first_visit
       from appointments a join appointment_assignments g on g.appointment_id = a.id and g.status <> 'superseded'
      where a.organisation_id = $1 and a.start_at >= $2 and a.start_at < $3
        and a.status in ('confirmed','checked_in','in_progress','replacement_pending','completed','no_show','cancelled_by_customer','cancelled_by_business')
      order by a.id, (g.status = 'active') desc, g.assigned_at desc`,
    [tx.ctx.orgId, from, to],
  );
  return rows
    .filter((r) => !staffId || r.staff_id === staffId)
    .map((r) => ({
      appointmentId: r.appointment_id, staffId: r.staff_id, customerId: r.customer_id, status: r.status, kind: r.kind,
      countsTowardKpi: r.counts_toward_kpi, startAt: r.start_at, scheduledMinutes: Math.round(r.sched), actualMinutes: r.actual_minutes,
      origin: r.origin, firstVisit: r.first_visit,
    }));
}

export interface KpiLine {
  definitionId: string;
  code: string;
  name: string;
  metric: KpiMetric;
  period: KpiPeriod;
  periodStart: string;
  periodEnd: string;
  result: MetricResult;
  target: number | null;
  progress: Progress | null;
  pace: Pace | null;
}

async function targetFor(tx: Tx, definitionId: string, staffId: string, on: string): Promise<number | null> {
  const row = await tx.maybeOne<{ target_value: number }>(
    `select target_value from staff_kpi_targets
      where kpi_definition_id = $1 and (staff_id = $2 or staff_id is null) and valid_from <= $3 and (valid_to is null or valid_to >= $3)
      order by (staff_id is not null) desc, valid_from desc limit 1`,
    [definitionId, staffId, on],
  );
  return row ? row.target_value : null;
}

/** Live KPI lines for one staff member, computed from appointment data with the explainable formulas in domain/kpi.ts. */
export async function staffKpiLines(tx: Tx, staffId: string, at: Date): Promise<KpiLine[]> {
  const settings = await loadSettings(tx);
  const basis: HoursBasis = settings.kpi.hoursBasis;
  const tzRow = await tx.maybeOne<{ timezone: string }>("select b.timezone from staff_profiles s join branches b on b.id = s.branch_id where s.id = $1", [staffId]);
  if (!tzRow) throw new AppError("NOT_FOUND", "Staff member not found.");
  const tz = tzRow.timezone;
  const defs = await tx.query<{ id: string; code: string; name: string; metric: KpiMetric; period: KpiPeriod; hours_basis: HoursBasis }>(
    "select id, code, name, metric, period, hours_basis from kpi_definitions where organisation_id = $1 and active order by name", [tx.ctx.orgId]);
  const hours = await tx.query<{ weekday: number; s: string; e: string }>(
    "select weekday, start_time::text s, end_time::text e from staff_working_hours where staff_id = $1 and status = 'approved'", [staffId]);

  const cache = new Map<string, WorkRecord[]>();
  const lines: KpiLine[] = [];
  for (const d of defs) {
    const b = periodBounds(d.period, at, tz);
    const ck = `${d.period}:${b.start.toISOString()}`;
    let records = cache.get(ck);
    if (!records) {
      records = await loadWorkRecords(tx, b.start, b.end, staffId);
      cache.set(ck, records);
    }
    let avail: number | undefined;
    if (d.metric === "utilisation_pct") {
      const ex = await tx.query<{ s: Date; e: Date }>(
        `select lower(period) s, upper(period) e from availability_exceptions
          where status = 'approved' and kind <> 'break' and (staff_id = $1 or staff_id is null) and period && tstzrange($2, $3, '[)')`, [staffId, b.start, b.end]);
      avail = availableMinutes(hours.map((h) => ({ weekday: h.weekday, start: h.s, end: h.e })), ex.map((x) => ({ start: x.s, end: x.e })), b.start, b.end, tz);
    }
    const result = computeMetric(d.metric, { records, basis: d.hours_basis === "actual" ? "actual" : basis, availableMinutes: avail });
    const target = await targetFor(tx, d.id, staffId, b.startDate);
    lines.push({
      definitionId: d.id, code: d.code, name: d.name, metric: d.metric, period: d.period, periodStart: b.startDate, periodEnd: b.endDate, result, target,
      progress: target ? progress(result.value, target) : null,
      pace: target ? pace(d.period, at, result.value, target, tz) : null,
    });
  }
  return lines;
}

/** Authorised entry point: masseuses see only themselves; managers may pass any staffId. */
export async function getKpiDashboard(principal: Principal, opts: { staffId?: string; at?: Date } = {}): Promise<{ staffId: string; lines: KpiLine[] }> {
  let staffId = opts.staffId;
  if (!can(principal, "kpi.read.all")) {
    if (!can(principal, "kpi.read.own") || !principal.staffId) throw new AppError("FORBIDDEN", "You do not have permission to do that.");
    if (staffId && staffId !== principal.staffId) throw new AppError("FORBIDDEN", "You can only view your own KPIs.");
    staffId = principal.staffId;
  }
  if (!staffId) throw new AppError("VALIDATION", "Choose a staff member.");
  const id = staffId;
  const lines = await withTx({ kind: "staff", orgId: principal.orgId, userId: principal.userId, staffId: principal.staffId, roles: principal.roles }, (tx) =>
    staffKpiLines(tx, id, opts.at ?? new Date()));
  return { staffId: id, lines };
}
