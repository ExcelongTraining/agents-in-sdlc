import { withTx } from "../db/tx";
import { requirePermission, type Principal } from "../domain/rbac";
import { availableMinutes, computeMetric } from "../domain/kpi";
import { loadWorkRecords } from "./kpi";
import { staffCtx } from "./schedule";

export interface OperationsReport {
  from: string;
  to: string;
  bySource: { source: string; count: number }[];
  byStatus: { status: string; count: number }[];
  cancellationRatePct: number;
  noShowRatePct: number;
  firstTimeClients: number;
  returningClients: number;
  staff: { staffId: string; name: string; scheduledHours: number; completedHours: number; consultationHours: number; replacementHours: number; completedAppointments: number; utilisationPct: number; sharePct: number }[];
  formulas: Record<string, string>;
}

const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

/**
 * Manager-only operations report for [from, to). Rates:
 *   cancellation rate = cancelled ÷ (confirmed + checked-in + in-progress + completed + no-show + cancelled)
 *   no-show rate      = no-show ÷ (completed + no-show)
 * Workload share = staff's completed hours ÷ all staff's completed hours (distribution, not a ranking).
 */
export async function operationsReport(principal: Principal, from: Date, to: Date): Promise<OperationsReport> {
  requirePermission(principal, "kpi.read.all");
  return withTx(staffCtx(principal), async (tx) => {
    const bySource = (await tx.query<{ source: string; n: number }>(
      "select source, count(*)::int n from appointments where start_at >= $1 and start_at < $2 and status not in ('draft','slot_held','expired','rescheduled') group by source order by n desc", [from, to]))
      .map((r) => ({ source: r.source, count: r.n }));
    const byStatus = (await tx.query<{ status: string; n: number }>(
      "select status, count(*)::int n from appointments where start_at >= $1 and start_at < $2 and status not in ('draft','slot_held','expired','rescheduled') group by status order by n desc", [from, to]))
      .map((r) => ({ status: r.status, count: r.n }));
    const c = (s: string) => byStatus.find((x) => x.status === s)?.count ?? 0;
    const cancelled = c("cancelled_by_customer") + c("cancelled_by_business");
    const denomCancel = cancelled + c("confirmed") + c("checked_in") + c("in_progress") + c("completed") + c("no_show") + c("replacement_pending");

    const records = await loadWorkRecords(tx, from, to);
    const staff = await tx.query<{ id: string; name: string; tz: string }>(
      "select sp.id, sp.display_name name, b.timezone tz from staff_profiles sp join branches b on b.id = sp.branch_id where sp.active and sp.archived_at is null order by sp.display_name");
    const rows = [];
    for (const s of staff) {
      const mine = records.filter((r) => r.staffId === s.id);
      const hours = await tx.query<{ weekday: number; s: string; e: string }>("select weekday, start_time::text s, end_time::text e from staff_working_hours where staff_id = $1 and status = 'approved'", [s.id]);
      const ex = await tx.query<{ s: Date; e: Date }>(
        "select lower(period) s, upper(period) e from availability_exceptions where status = 'approved' and kind <> 'break' and (staff_id = $1 or staff_id is null) and period && tstzrange($2,$3,'[)')", [s.id, from, to]);
      const avail = availableMinutes(hours.map((h) => ({ weekday: h.weekday, start: h.s, end: h.e })), ex.map((x) => ({ start: x.s, end: x.e })), from, to, s.tz);
      const m = (metric: Parameters<typeof computeMetric>[0]) => computeMetric(metric, { records: mine, basis: "scheduled", availableMinutes: avail }).value;
      rows.push({ staffId: s.id, name: s.name, scheduledHours: m("scheduled_service_hours"), completedHours: m("completed_service_hours"), consultationHours: m("consultation_hours"),
        replacementHours: m("replacement_hours"), completedAppointments: m("completed_appointments"), utilisationPct: m("utilisation_pct"), sharePct: 0 });
    }
    const totalCompleted = rows.reduce((a, r) => a + r.completedHours, 0);
    for (const r of rows) r.sharePct = pct(r.completedHours, totalCompleted);
    const completed = records.filter((r) => r.status === "completed");
    return {
      from: from.toISOString(), to: to.toISOString(), bySource, byStatus,
      cancellationRatePct: pct(cancelled, denomCancel), noShowRatePct: pct(c("no_show"), c("completed") + c("no_show")),
      firstTimeClients: new Set(completed.filter((r) => r.firstVisit && r.customerId).map((r) => r.customerId)).size,
      returningClients: new Set(completed.filter((r) => !r.firstVisit && r.customerId).map((r) => r.customerId)).size,
      staff: rows,
      formulas: {
        cancellationRate: "cancelled ÷ (cancelled + confirmed + checked-in + in-progress + completed + no-show) × 100",
        noShowRate: "no-show ÷ (completed + no-show) × 100",
        utilisation: "completed minutes ÷ available minutes (working hours minus leave/blocked/training) × 100",
        share: "staff completed hours ÷ total completed hours × 100",
      },
    };
  });
}
