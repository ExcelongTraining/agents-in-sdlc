import type { KpiLine } from "@/lib/services/kpi";

const label = { ahead: "Ahead of pace", on_track: "On track", behind: "A little behind pace" } as const;

export function KpiTable({ lines }: { lines: KpiLine[] }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {lines
          .filter((l) => l.target && l.progress)
          .map((l) => (
            <div key={l.definitionId} className="card space-y-2">
              <h3 className="font-semibold">{l.name}</h3>
              <p className="text-3xl font-bold">
                {l.progress!.progressPct}%{" "}
                <span className="text-base font-normal text-muted">
                  of {l.target} {l.result.unit === "hours" ? "hours" : ""}
                </span>
              </p>
              <div
                role="progressbar"
                aria-label={l.name}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.min(100, Math.round(l.progress!.progressPct))}
                className="h-3 w-full overflow-hidden rounded-full bg-brand-soft"
              >
                <div
                  className="h-full bg-brand"
                  style={{ width: `${Math.min(100, l.progress!.progressPct)}%` }}
                />
              </div>
              <p className="text-sm">
                {l.result.value} done · {l.progress!.remaining} remaining
                {l.pace ? ` · ${label[l.pace.status]}` : ""}
              </p>
            </div>
          ))}
      </div>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="All KPIs (scrollable)">
        <table className="table">
          <caption className="sr-only">All KPIs</caption>
          <thead>
            <tr>
              <th scope="col">KPI</th>
              <th scope="col">Period</th>
              <th scope="col">Value</th>
              <th scope="col">How it is calculated</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.definitionId}>
                <th scope="row" className="font-normal">
                  {l.name}
                </th>
                <td>
                  {l.periodStart} → {l.periodEnd}
                </td>
                <td>
                  {l.result.value}
                  {l.result.unit === "percent" ? "%" : l.result.unit === "hours" ? " h" : ""}
                </td>
                <td className="text-muted">{l.result.explanation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
