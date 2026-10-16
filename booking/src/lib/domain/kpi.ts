import { addMinutes, DateTime, periodBounds, type KpiPeriod } from "./time";
import type { TimeWindow } from "./availability";

export type KpiMetric =
  | "completed_service_hours"
  | "scheduled_service_hours"
  | "consultation_hours"
  | "replacement_hours"
  | "cancelled_hours"
  | "no_show_hours"
  | "utilisation_pct"
  | "completed_appointments"
  | "first_time_clients"
  | "returning_clients";

export type HoursBasis = "scheduled" | "actual";

/** One appointment credited to one staff member. The SQL loader guarantees exactly one credited staff per appointment. */
export interface WorkRecord {
  appointmentId: string;
  staffId: string;
  customerId: string | null;
  status: string;
  kind: "service" | "trial" | "consultation";
  countsTowardKpi: boolean;
  startAt: Date;
  scheduledMinutes: number;
  actualMinutes: number | null;
  /** origin of the credited assignment */
  origin: "booking" | "manager_reassign" | "replacement";
  /** true when this was the customer's first ever completed appointment with the business */
  firstVisit: boolean;
}

export interface MetricResult {
  metric: KpiMetric;
  value: number;
  unit: "hours" | "count" | "percent";
  /** Human-readable formula with the actual inputs, shown in the UI ("how is this calculated?"). */
  explanation: string;
  inputs: Record<string, number>;
}

const COMPLETED = "completed";
const SCHEDULED_STATUSES = new Set([
  "confirmed",
  "checked_in",
  "in_progress",
  "replacement_pending",
  "completed",
]);
const CANCELLED = new Set(["cancelled_by_customer", "cancelled_by_business"]);

const minutesOf = (r: WorkRecord, basis: HoursBasis): number =>
  basis === "actual" ? (r.actualMinutes ?? r.scheduledMinutes) : r.scheduledMinutes;
const toHours = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;

export interface KpiInput {
  records: WorkRecord[]; // already limited to one staff member and one period (start within [periodStart, periodEnd))
  basis: HoursBasis;
  /** Minutes the staff member was available (working hours minus leave etc.). Needed for utilisation only. */
  availableMinutes?: number;
}

/**
 * Explainable KPI formulas. Definitions (also shown to users):
 *  - completed_service_hours : Σ minutes of COMPLETED appointments of kind service/trial whose service counts toward KPI ÷ 60
 *  - scheduled_service_hours : same filter but statuses confirmed/checked_in/in_progress/replacement_pending/completed
 *  - consultation_hours      : Σ minutes of COMPLETED consultation appointments ÷ 60 (reported separately; ignores the KPI flag)
 *  - replacement_hours       : part of completed_service_hours credited because the staff member was a REPLACEMENT
 *  - cancelled_hours / no_show_hours : Σ minutes of cancelled / no-show appointments last assigned to the staff member ÷ 60
 *  - utilisation_pct         : completed minutes (any kind) ÷ available minutes × 100
 *  - completed_appointments  : count of COMPLETED appointments that count toward KPI
 *  - first_time_clients / returning_clients : distinct customers in completed appointments, split by whether it was their first visit
 * An appointment is credited to exactly one staff member (the active assignment at completion), so replaced staff
 * are never credited for the same appointment.
 */
export function computeMetric(metric: KpiMetric, input: KpiInput): MetricResult {
  const { records, basis } = input;
  const m = (r: WorkRecord) => minutesOf(r, basis);
  const completed = records.filter((r) => r.status === COMPLETED);
  switch (metric) {
    case "completed_service_hours": {
      const set = completed.filter((r) => r.kind !== "consultation" && r.countsTowardKpi);
      const minutes = sum(set.map(m));
      return res(
        metric,
        toHours(minutes),
        "hours",
        `${set.length} completed appointment(s) totalling ${minutes} min ÷ 60 (${basis} duration)`,
        { appointments: set.length, minutes },
      );
    }
    case "scheduled_service_hours": {
      const set = records.filter(
        (r) => SCHEDULED_STATUSES.has(r.status) && r.kind !== "consultation" && r.countsTowardKpi,
      );
      const minutes = sum(set.map((r) => r.scheduledMinutes));
      return res(
        metric,
        toHours(minutes),
        "hours",
        `${set.length} scheduled appointment(s) totalling ${minutes} min ÷ 60`,
        { appointments: set.length, minutes },
      );
    }
    case "consultation_hours": {
      const set = completed.filter((r) => r.kind === "consultation");
      const minutes = sum(set.map(m));
      return res(
        metric,
        toHours(minutes),
        "hours",
        `${set.length} completed consultation(s) totalling ${minutes} min ÷ 60`,
        { appointments: set.length, minutes },
      );
    }
    case "replacement_hours": {
      const set = completed.filter(
        (r) => r.origin === "replacement" && r.kind !== "consultation" && r.countsTowardKpi,
      );
      const minutes = sum(set.map(m));
      return res(
        metric,
        toHours(minutes),
        "hours",
        `${set.length} completed appointment(s) taken over as replacement, ${minutes} min ÷ 60`,
        { appointments: set.length, minutes },
      );
    }
    case "cancelled_hours": {
      const set = records.filter((r) => CANCELLED.has(r.status));
      const minutes = sum(set.map((r) => r.scheduledMinutes));
      return res(
        metric,
        toHours(minutes),
        "hours",
        `${set.length} cancelled appointment(s) totalling ${minutes} min ÷ 60`,
        { appointments: set.length, minutes },
      );
    }
    case "no_show_hours": {
      const set = records.filter((r) => r.status === "no_show");
      const minutes = sum(set.map((r) => r.scheduledMinutes));
      return res(
        metric,
        toHours(minutes),
        "hours",
        `${set.length} no-show(s) totalling ${minutes} min ÷ 60`,
        { appointments: set.length, minutes },
      );
    }
    case "utilisation_pct": {
      const minutes = sum(completed.map(m));
      const avail = input.availableMinutes ?? 0;
      const pct = avail > 0 ? Math.round((minutes / avail) * 1000) / 10 : 0;
      return res(metric, pct, "percent", `${minutes} completed min ÷ ${avail} available min × 100`, {
        completedMinutes: minutes,
        availableMinutes: avail,
      });
    }
    case "completed_appointments": {
      const set = completed.filter((r) => r.countsTowardKpi);
      return res(
        metric,
        set.length,
        "count",
        `${set.length} completed appointment(s) that count toward KPI`,
        { appointments: set.length },
      );
    }
    case "first_time_clients": {
      const ids = new Set(completed.filter((r) => r.firstVisit && r.customerId).map((r) => r.customerId));
      return res(metric, ids.size, "count", `${ids.size} distinct client(s) on their first completed visit`, {
        clients: ids.size,
      });
    }
    case "returning_clients": {
      const ids = new Set(completed.filter((r) => !r.firstVisit && r.customerId).map((r) => r.customerId));
      return res(metric, ids.size, "count", `${ids.size} distinct returning client(s)`, {
        clients: ids.size,
      });
    }
  }
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const res = (
  metric: KpiMetric,
  value: number,
  unit: MetricResult["unit"],
  explanation: string,
  inputs: Record<string, number>,
): MetricResult => ({
  metric,
  value,
  unit,
  explanation,
  inputs,
});

export interface Progress {
  actual: number;
  target: number;
  /** actual ÷ target × 100, one decimal; may exceed 100 */
  progressPct: number;
  remaining: number;
  explanation: string;
}

/** Example: target 120, actual 78 -> 65.0 %, remaining 42. */
export function progress(actual: number, target: number): Progress {
  if (target <= 0) return { actual, target, progressPct: 0, remaining: 0, explanation: "No target set" };
  const pct = Math.round((actual / target) * 1000) / 10;
  const remaining = Math.max(Math.round((target - actual) * 100) / 100, 0);
  return {
    actual,
    target,
    progressPct: pct,
    remaining,
    explanation: `${actual} ÷ ${target} × 100 = ${pct}%; remaining = max(${target} − ${actual}, 0) = ${remaining}`,
  };
}

/**
 * Minutes a staff member is available inside [start, end): approved weekly working windows (in `tz`) minus
 * overlapping leave/blocked/training exceptions. Breaks are NOT subtracted (paid-time convention is a business
 * decision; pass them in `exceptions` to subtract them).
 */
export function availableMinutes(
  workingHours: TimeWindow[],
  exceptions: { start: Date; end: Date }[],
  start: Date,
  end: Date,
  tz: string,
): number {
  let total = 0;
  let day = DateTime.fromJSDate(start, { zone: tz }).startOf("day");
  const last = DateTime.fromJSDate(end, { zone: tz });
  while (day < last) {
    for (const w of workingHours.filter((x) => x.weekday === day.weekday)) {
      const [sh = "0", sm = "0"] = w.start.split(":");
      const [eh = "0", em = "0"] = w.end.split(":");
      let ws = day
        .set({ hour: Number(sh), minute: Number(sm) })
        .toUTC()
        .toJSDate();
      let we = day
        .set({ hour: Number(eh), minute: Number(em) })
        .toUTC()
        .toJSDate();
      if (ws < start) ws = start;
      if (we > end) we = end;
      if (we <= ws) continue;
      // subtract union of exception overlaps
      const cuts = exceptions
        .map((e) => ({
          s: Math.max(e.start.getTime(), ws.getTime()),
          e: Math.min(e.end.getTime(), we.getTime()),
        }))
        .filter((c) => c.e > c.s)
        .sort((a, b) => a.s - b.s);
      let covered = 0;
      let curS = -1;
      let curE = -1;
      for (const c of cuts) {
        if (curE < c.s) {
          if (curE > curS) covered += curE - curS;
          curS = c.s;
          curE = c.e;
        } else curE = Math.max(curE, c.e);
      }
      if (curE > curS) covered += curE - curS;
      total += Math.round((we.getTime() - ws.getTime() - covered) / 60_000);
    }
    day = day.plus({ days: 1 });
  }
  return total;
}

export interface Pace {
  expectedByNow: number;
  status: "ahead" | "on_track" | "behind";
  elapsedFraction: number;
}

/** Linear pace: how much of the target would be done if work were spread evenly across the period so far. */
export function pace(period: KpiPeriod, at: Date, actual: number, target: number, tz: string): Pace {
  const b = periodBounds(period, at, tz);
  const elapsed = Math.min(
    Math.max((at.getTime() - b.start.getTime()) / (b.end.getTime() - b.start.getTime()), 0),
    1,
  );
  const expected = Math.round(target * elapsed * 100) / 100;
  const status = actual >= expected * 1.05 ? "ahead" : actual >= expected * 0.85 ? "on_track" : "behind";
  return { expectedByNow: expected, status, elapsedFraction: Math.round(elapsed * 1000) / 1000 };
}

export { addMinutes };
