"use client";
import { useEffect, useState } from "react";
import { Alert, Check, TextField, api } from "./ui";
import { useAction } from "./actions";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function BusinessHoursEditor() {
  const { error, busy, run } = useAction();
  const [rows, setRows] = useState<Record<number, { on: boolean; start: string; end: string }>>({});
  const [ok, setOk] = useState("");
  useEffect(() => {
    api<{ windows: { weekday: number; start: string; end: string }[] }>("/api/admin/business-hours")
      .then((r) => {
        const next: Record<number, { on: boolean; start: string; end: string }> = {};
        for (let d = 1; d <= 7; d++) next[d] = { on: false, start: "09:00", end: "21:00" };
        for (const w of r.windows)
          next[w.weekday] = { on: true, start: w.start.slice(0, 5), end: w.end.slice(0, 5) };
        setRows(next);
      })
      .catch(() => undefined);
  }, []);
  return (
    <form
      className="card max-w-xl space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setOk("");
        void run(async () => {
          await api("/api/admin/business-hours", {
            method: "PUT",
            body: {
              windows: Object.entries(rows)
                .filter(([, r]) => r.on)
                .map(([d, r]) => ({ weekday: Number(d), start: r.start, end: r.end })),
            },
          });
          setOk("Business hours saved.");
        });
      }}
    >
      <h2 className="text-lg font-semibold">Business hours</h2>
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}
      <table className="table">
        <caption className="sr-only">Business hours</caption>
        <thead>
          <tr>
            <th scope="col">Open</th>
            <th scope="col">Day</th>
            <th scope="col">From</th>
            <th scope="col">Until</th>
          </tr>
        </thead>
        <tbody>
          {DAYS.map((name, i) => {
            const d = i + 1;
            const r = rows[d] ?? { on: false, start: "09:00", end: "21:00" };
            return (
              <tr key={d}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Open on ${name}`}
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
                    aria-label={`${name} opens`}
                    type="time"
                    className="input"
                    value={r.start}
                    disabled={!r.on}
                    onChange={(e) => setRows({ ...rows, [d]: { ...r, start: e.target.value } })}
                  />
                </td>
                <td>
                  <input
                    aria-label={`${name} closes`}
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
        Save business hours
      </button>
      <p className="hint">Public holidays and closures: add a “Branch closure” under Availability & leave.</p>
    </form>
  );
}

export function RoomsEditor({ rooms }: { rooms: { id: string; name: string; active: boolean }[] }) {
  const { error, busy, run } = useAction();
  const [name, setName] = useState("");
  return (
    <div className="card max-w-xl space-y-3">
      <h2 className="text-lg font-semibold">Rooms</h2>
      {error && <Alert kind="error">{error}</Alert>}
      <ul className="space-y-2">
        {rooms.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2">
            <span>
              {r.name} {!r.active && <span className="badge badge-warn">inactive</span>}
            </span>
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  api("/api/admin/rooms", { body: { id: r.id, name: r.name, active: !r.active } }),
                )
              }
            >
              {r.active ? "Deactivate" : "Activate"}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("/api/admin/rooms", { body: { name, active: true } });
            setName("");
          });
        }}
      >
        <div className="flex-1">
          <TextField
            label="Add a room"
            required
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button className="btn" disabled={busy}>
          Add
        </button>
      </form>
      <Check
        checked
        disabled
        onChange={() => undefined}
        label="Services marked “needs a room” can only be booked while a room is free."
      />
    </div>
  );
}
