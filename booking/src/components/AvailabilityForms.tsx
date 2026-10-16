"use client";
import { useEffect, useState } from "react";
import { Alert, SelectField, TextField, api } from "./ui";
import { useAction } from "./actions";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const asKL = (local: string) => (local ? new Date(local + ":00+08:00").toISOString() : "");

export function ExceptionForm({ staff, self }: { staff: { id: string; name: string }[]; self?: boolean }) {
  const { error, busy, run } = useAction();
  const [ok, setOk] = useState("");
  const [f, setF] = useState({
    staffId: self ? "" : (staff[0]?.id ?? ""),
    kind: "leave",
    start: "",
    end: "",
    reason: "",
  });
  return (
    <form
      className="card max-w-xl space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setOk("");
        void run(async () => {
          const r = await api<{ status: string }>("/api/availability/exceptions", {
            body: {
              staffId: self || f.kind === "closure" ? undefined : f.staffId,
              kind: f.kind,
              start: asKL(f.start),
              end: asKL(f.end),
              reason: f.reason || undefined,
            },
          });
          setOk(r.status === "pending" ? "Request sent to the manager for approval." : "Saved.");
        });
      }}
    >
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        {!self && f.kind !== "closure" && (
          <SelectField
            label="Staff member"
            value={f.staffId}
            onChange={(e) => setF({ ...f, staffId: e.target.value })}
          >
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectField>
        )}
        <SelectField label="Type" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="leave">Leave</option>
          <option value="break">Break</option>
          <option value="blocked">Unavailable / blocked time</option>
          {!self && (
            <>
              <option value="training">Training</option>
              <option value="internal">Internal activity</option>
              <option value="closure">Branch closure (everyone)</option>
            </>
          )}
        </SelectField>
        <TextField
          label="From"
          type="datetime-local"
          required
          value={f.start}
          onChange={(e) => setF({ ...f, start: e.target.value })}
        />
        <TextField
          label="Until"
          type="datetime-local"
          required
          value={f.end}
          onChange={(e) => setF({ ...f, end: e.target.value })}
        />
      </div>
      <TextField
        label="Reason (optional)"
        maxLength={200}
        hint="Keep it general, for example “annual leave”. Do not record medical details."
        value={f.reason}
        onChange={(e) => setF({ ...f, reason: e.target.value })}
      />
      <button className="btn btn-primary" disabled={busy}>
        {self ? "Request time off" : "Save"}
      </button>
    </form>
  );
}

interface Win {
  weekday: number;
  start: string;
  end: string;
  status?: string;
}

export function HoursEditor({
  staff,
  manager,
}: {
  staff: { id: string; name: string }[];
  manager?: boolean;
}) {
  const { error, busy, run } = useAction();
  const [staffId, setStaffId] = useState(staff[0]?.id ?? "");
  const [rows, setRows] = useState<Record<number, { on: boolean; start: string; end: string }>>({});
  const [ok, setOk] = useState("");
  useEffect(() => {
    api<{ windows: Win[] }>(`/api/availability/hours${manager ? `?staffId=${staffId}` : ""}`)
      .then((r) => {
        const next: Record<number, { on: boolean; start: string; end: string }> = {};
        for (let d = 1; d <= 7; d++) next[d] = { on: false, start: "10:00", end: "18:00" };
        for (const w of r.windows.filter((x) => x.status === "approved"))
          next[w.weekday] = { on: true, start: w.start.slice(0, 5), end: w.end.slice(0, 5) };
        setRows(next);
      })
      .catch(() => undefined);
  }, [staffId, manager]);
  return (
    <form
      className="card max-w-xl space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setOk("");
        void run(async () => {
          const windows = Object.entries(rows)
            .filter(([, r]) => r.on)
            .map(([d, r]) => ({ weekday: Number(d), start: r.start, end: r.end }));
          const r = await api<{ status: string }>("/api/availability/hours", {
            body: { staffId: manager ? staffId : undefined, windows },
          });
          setOk(
            r.status === "pending"
              ? "Your proposed hours were sent for manager approval. Current hours stay in force until then."
              : "Working hours saved.",
          );
        });
      }}
    >
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}
      {manager && (
        <SelectField label="Staff member" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectField>
      )}
      <table className="table">
        <caption className="sr-only">Weekly working hours</caption>
        <thead>
          <tr>
            <th scope="col">Working</th>
            <th scope="col">Day</th>
            <th scope="col">From</th>
            <th scope="col">Until</th>
          </tr>
        </thead>
        <tbody>
          {DAYS.map((name, i) => {
            const d = i + 1;
            const r = rows[d] ?? { on: false, start: "10:00", end: "18:00" };
            return (
              <tr key={d}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Works on ${name}`}
                    className="h-5 w-5 accent-[var(--brand)]"
                    checked={r.on}
                    onChange={(e) => setRows({ ...rows, [d]: { ...r, on: e.target.checked } })}
                  />
                </td>
                <th scope="row" className="font-normal">
                  {name}
                </th>
                <td>
                  <input
                    aria-label={`${name} start`}
                    type="time"
                    className="input"
                    value={r.start}
                    disabled={!r.on}
                    onChange={(e) => setRows({ ...rows, [d]: { ...r, start: e.target.value } })}
                  />
                </td>
                <td>
                  <input
                    aria-label={`${name} end`}
                    type="time"
                    className="input"
                    value={r.end}
                    disabled={!r.on}
                    onChange={(e) => setRows({ ...rows, [d]: { ...r, end: e.target.value } })}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button className="btn btn-primary" disabled={busy}>
        {manager ? "Save hours" : "Propose these hours"}
      </button>
    </form>
  );
}
