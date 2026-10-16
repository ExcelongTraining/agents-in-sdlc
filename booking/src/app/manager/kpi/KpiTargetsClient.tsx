"use client";
import { useState } from "react";
import { Alert, SelectField, TextField, api } from "@/components/ui";
import { useAction } from "@/components/actions";

interface Def {
  id: string;
  code: string;
  name: string;
  metric: string;
  period: string;
}
interface Target {
  id: string;
  definitionId: string;
  staffId: string | null;
  value: number;
  from: string;
}

export function KpiTargetsClient({
  defs,
  targets,
  staff,
}: {
  defs: Def[];
  targets: Target[];
  staff: { id: string; name: string }[];
}) {
  const { error, busy, run } = useAction();
  const [f, setF] = useState({
    definitionId: defs[0]?.id ?? "",
    staffId: "",
    value: "",
    from: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" }),
  });
  const nameOf = (id: string | null) => (id ? (staff.find((s) => s.id === id)?.name ?? "?") : "Everyone");
  return (
    <div className="space-y-4">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Current targets (scrollable)">
        <table className="table">
          <caption className="sr-only">Current targets</caption>
          <thead>
            <tr>
              <th scope="col">KPI</th>
              <th scope="col">Period</th>
              <th scope="col">For</th>
              <th scope="col">Target</th>
              <th scope="col">From</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((t) => {
              const d = defs.find((x) => x.id === t.definitionId);
              return (
                <tr key={t.id}>
                  <th scope="row" className="font-normal">
                    {d?.name}
                  </th>
                  <td>{d?.period}</td>
                  <td>{nameOf(t.staffId)}</td>
                  <td>{t.value}</td>
                  <td>{t.from}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <form
        className="card max-w-xl space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() =>
            api("/api/admin/kpi-targets", {
              method: "PUT",
              body: {
                definitionId: f.definitionId,
                staffId: f.staffId || null,
                targetValue: Number(f.value),
                validFrom: f.from,
              },
            }),
          );
        }}
      >
        <h2 className="text-lg font-semibold">Set a target</h2>
        <SelectField
          label="KPI"
          value={f.definitionId}
          onChange={(e) => setF({ ...f, definitionId: e.target.value })}
        >
          {defs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="For" value={f.staffId} onChange={(e) => setF({ ...f, staffId: e.target.value })}>
          <option value="">Everyone</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Target value"
          type="number"
          step="0.5"
          min="0.5"
          required
          value={f.value}
          onChange={(e) => setF({ ...f, value: e.target.value })}
          hint="Hours, appointments or percent, depending on the KPI."
        />
        <TextField
          label="Applies from"
          type="date"
          required
          value={f.from}
          onChange={(e) => setF({ ...f, from: e.target.value })}
        />
        <button className="btn btn-primary" disabled={busy}>
          Save target
        </button>
      </form>
    </div>
  );
}
