"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import type { DatesSetArg, EventDropArg, EventClickArg, EventInput } from "@fullcalendar/core";
import { Alert, SelectField, api, errorMessage } from "./ui";

interface Item {
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
  customerPhone: string | null;
  note: string | null;
  replacementPending: boolean;
}

// Colour-blind-safe palette; status is also conveyed by text/pattern, never colour alone.
const PALETTE = ["#0f6b62", "#6d28d9", "#b45309", "#1d4ed8", "#be123c", "#4d7c0f", "#0e7490"];

/** Master schedule. Drag-and-drop reschedules through the server; a conflict reverts the move and explains why. */
export function CalendarView({
  staff,
  canEdit,
}: {
  staff: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Item | null>(null);
  const [live, setLive] = useState("");
  const range = useRef<{ from: string; to: string } | null>(null);

  const load = useCallback(async () => {
    if (!range.current) return;
    try {
      const r = await api<{ items: Item[] }>(
        `/api/schedule?from=${encodeURIComponent(range.current.from)}&to=${encodeURIComponent(range.current.to)}`,
      );
      setItems(r.items);
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  const events: EventInput[] = useMemo(
    () =>
      items
        .filter((i) => !filter || i.staffId === filter)
        .map((i) => {
          const idx = Math.max(
            0,
            staff.findIndex((s) => s.id === i.staffId),
          );
          const dim = ["completed", "no_show", "cancelled_by_customer", "cancelled_by_business"].includes(
            i.status,
          );
          return {
            id: i.id,
            start: i.startAt,
            end: i.endAt,
            title: `${i.staffName ?? "?"} · ${i.customerName ?? "Customer"} · ${i.serviceName}${i.replacementPending ? " ⚠ replacement pending" : ""}${dim ? ` (${i.status.replaceAll("_", " ")})` : ""}`,
            backgroundColor: PALETTE[idx % PALETTE.length],
            borderColor: PALETTE[idx % PALETTE.length],
            textColor: "#fff",
            classNames: dim ? ["opacity-50"] : [],
            editable: canEdit && i.status === "confirmed",
            extendedProps: { item: i },
          };
        }),
    [items, filter, staff, canEdit],
  );

  async function onDrop(arg: EventDropArg) {
    const item = arg.event.extendedProps.item as Item;
    if (!arg.event.start) return arg.revert();
    try {
      await api(`/api/appointments/${item.id}/reschedule`, {
        body: { newStartAt: arg.event.start.toISOString(), reason: "Moved on the calendar" },
      });
      setLive(`Moved ${item.serviceName} to ${arg.event.start.toLocaleString()}.`);
      setError("");
      await load();
    } catch (e) {
      arg.revert();
      setError(errorMessage(e));
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48">
          <SelectField label="Masseuse" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">Everyone</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectField>
        </div>
        <ul className="flex flex-wrap gap-2 pb-2 text-xs" aria-label="Colour key">
          {staff.map((s, i) => (
            <li key={s.id} className="flex items-center gap-1">
              <span
                aria-hidden
                className="inline-block h-3 w-3 rounded"
                style={{ background: PALETTE[i % PALETTE.length] }}
              />
              {s.name}
            </li>
          ))}
        </ul>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      <p className="sr-only" role="status">
        {live}
      </p>
      <div className="card p-2">
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView={
            typeof window !== "undefined" && window.innerWidth < 700 ? "timeGridDay" : "timeGridWeek"
          }
          headerToolbar={{
            left: "prev,next today",
            center: "title",
            right: "timeGridDay,timeGridWeek,dayGridMonth",
          }}
          timeZone="Asia/Kuala_Lumpur"
          slotMinTime="08:00:00"
          slotMaxTime="22:00:00"
          allDaySlot={false}
          nowIndicator
          height="auto"
          snapDuration="00:15:00"
          editable={canEdit}
          eventDurationEditable={false}
          events={events}
          datesSet={(a: DatesSetArg) => {
            range.current = { from: a.start.toISOString(), to: a.end.toISOString() };
            void load();
          }}
          eventDrop={onDrop}
          eventClick={(a: EventClickArg) => setSelected(a.event.extendedProps.item as Item)}
        />
      </div>
      {selected && (
        <section className="card space-y-2" aria-label="Appointment details">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-lg font-semibold">{selected.serviceName}</h2>
            <button className="btn" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <p>
            {new Date(selected.startAt).toLocaleString("en-MY", {
              dateStyle: "full",
              timeStyle: "short",
              timeZone: "Asia/Kuala_Lumpur",
            })}
          </p>
          <p>
            With <strong>{selected.staffName}</strong> · {selected.customerName} · {selected.customerPhone}
          </p>
          <p>
            <span className="badge">{selected.status.replaceAll("_", " ")}</span>{" "}
            <span className="badge badge-warn">{selected.source.replaceAll("_", " ")}</span>
          </p>
          {selected.note && <p className="text-sm">Note: {selected.note}</p>}
          {canEdit && (
            <ManagerActions
              item={selected}
              staff={staff}
              onDone={() => {
                setSelected(null);
                void load();
              }}
            />
          )}
        </section>
      )}
    </div>
  );
}

function ManagerActions({
  item,
  staff,
  onDone,
}: {
  item: Item;
  staff: { id: string; name: string }[];
  onDone: () => void;
}) {
  const [who, setWho] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const live = [
    "confirmed",
    "pending_confirmation",
    "checked_in",
    "in_progress",
    "replacement_pending",
  ].includes(item.status);
  if (!live) return null;
  return (
    <div className="space-y-3 border-t border-line pt-3">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        {item.status === "confirmed" && (
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(() => api(`/api/appointments/${item.id}/status`, { body: { to: "checked_in" } }))
            }
          >
            Check in
          </button>
        )}
        {["confirmed", "checked_in"].includes(item.status) && (
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(() => api(`/api/appointments/${item.id}/status`, { body: { to: "in_progress" } }))
            }
          >
            Start
          </button>
        )}
        {["confirmed", "in_progress"].includes(item.status) && (
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() =>
              void run(() => api(`/api/appointments/${item.id}/status`, { body: { to: "completed" } }))
            }
          >
            Complete
          </button>
        )}
        {item.status === "confirmed" && (
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(() => api(`/api/appointments/${item.id}/status`, { body: { to: "no_show" } }))
            }
          >
            No-show
          </button>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <SelectField label="Reassign to" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Choose…</option>
          {staff
            .filter((s) => s.id !== item.staffId)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </SelectField>
        <label className="sm:col-span-1">
          <span className="label">Reason</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="self-end">
          <button
            className="btn"
            disabled={busy || !who || reason.trim().length < 3}
            onClick={() =>
              void run(() =>
                api(`/api/appointments/${item.id}/reassign`, { body: { newStaffId: who, reason } }),
              )
            }
          >
            Reassign
          </button>
        </div>
      </div>
      <button
        className="btn btn-danger"
        disabled={busy}
        onClick={() => {
          if (confirm("Cancel this appointment? The customer will be notified."))
            void run(() =>
              api(`/api/appointments/${item.id}/cancel`, {
                body: { reason: reason || "Cancelled by the centre" },
              }),
            );
        }}
      >
        Cancel appointment
      </button>
    </div>
  );
}
