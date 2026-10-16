import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { operationsReport } from "@/lib/services/reports";
import { getKpiDashboard } from "@/lib/services/kpi";
import { listStaff } from "@/lib/services/schedule";
import { periodBounds } from "@/lib/domain/time";
import { KpiTable } from "@/components/KpiTable";

export const metadata: Metadata = { title: "Reports and KPIs" };
export const dynamic = "force-dynamic";

export default async function Reports({ searchParams }: { searchParams: Promise<{ staff?: string }> }) {
  const p = await requireRole(["manager"]);
  const sp = await searchParams;
  const m = periodBounds("month", new Date());
  const [report, staff] = await Promise.all([operationsReport(p, m.start, m.end), listStaff(p)]);
  const chosen = staff.find((s) => s.id === sp.staff) ?? staff[0];
  const kpi = chosen ? await getKpiDashboard(p, { staffId: chosen.id }) : null;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">
        Reports & KPIs{" "}
        <span className="text-base text-muted">
          ({m.startDate} to {m.endDate})
        </span>
      </h1>
      <section className="grid gap-3 sm:grid-cols-4" aria-label="Rates">
        <div className="card">
          <p className="text-sm text-muted">Cancellation rate</p>
          <p className="text-3xl font-bold">{report.cancellationRatePct}%</p>
        </div>
        <div className="card">
          <p className="text-sm text-muted">No-show rate</p>
          <p className="text-3xl font-bold">{report.noShowRatePct}%</p>
        </div>
        <div className="card">
          <p className="text-sm text-muted">First-time clients served</p>
          <p className="text-3xl font-bold">{report.firstTimeClients}</p>
        </div>
        <div className="card">
          <p className="text-sm text-muted">Returning clients served</p>
          <p className="text-3xl font-bold">{report.returningClients}</p>
        </div>
      </section>
      <section>
        <h2 className="text-xl font-semibold">Workload by masseuse</h2>
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Hours and utilisation per masseuse this month (scrollable)"
        >
          <table className="table">
            <caption className="sr-only">Hours and utilisation per masseuse this month</caption>
            <thead>
              <tr>
                <th scope="col">Masseuse</th>
                <th scope="col">Completed h</th>
                <th scope="col">Scheduled h</th>
                <th scope="col">Consultation h</th>
                <th scope="col">Replacement h</th>
                <th scope="col">Appointments</th>
                <th scope="col">Utilisation</th>
                <th scope="col">Share</th>
              </tr>
            </thead>
            <tbody>
              {report.staff.map((s) => (
                <tr key={s.staffId}>
                  <th scope="row" className="font-normal">
                    {s.name}
                  </th>
                  <td>{s.completedHours}</td>
                  <td>{s.scheduledHours}</td>
                  <td>{s.consultationHours}</td>
                  <td>{s.replacementHours}</td>
                  <td>{s.completedAppointments}</td>
                  <td>{s.utilisationPct}%</td>
                  <td>{s.sharePct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="grid gap-4 sm:grid-cols-2">
        <div>
          <h2 className="text-xl font-semibold">Bookings by source</h2>
          <ul className="mt-2 space-y-1">
            {report.bySource.map((s) => (
              <li key={s.source} className="flex justify-between">
                <span>{s.source.replaceAll("_", " ")}</span>
                <strong>{s.count}</strong>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="text-xl font-semibold">By status</h2>
          <ul className="mt-2 space-y-1">
            {report.byStatus.map((s) => (
              <li key={s.status} className="flex justify-between">
                <span>{s.status.replaceAll("_", " ")}</span>
                <strong>{s.count}</strong>
              </li>
            ))}
          </ul>
        </div>
      </section>
      <details className="card">
        <summary className="cursor-pointer font-semibold">How these are calculated</summary>
        <ul className="mt-2 list-disc pl-5 text-sm">
          {Object.entries(report.formulas).map(([k, v]) => (
            <li key={k}>
              <strong>{k}</strong>: {v}
            </li>
          ))}
        </ul>
      </details>
      <section>
        <h2 className="text-xl font-semibold">KPI progress</h2>
        <form className="my-2 flex items-end gap-2" method="get">
          <label className="label" htmlFor="staff">
            Masseuse
          </label>
          <select id="staff" name="staff" className="input max-w-xs" defaultValue={chosen?.id}>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="btn">Show</button>
        </form>
        {kpi && <KpiTable lines={kpi.lines} />}
      </section>
    </div>
  );
}
