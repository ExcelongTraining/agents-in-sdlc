"use client";
import { useCallback, useEffect, useState } from "react";
import { Alert, SelectField, api, errorMessage } from "@/components/ui";

interface Booking {
  appointmentId: string;
  status: string;
  serviceName: string;
  staffName: string | null;
  branchName: string;
  startLocal: string;
  startAt: string;
  canChange: boolean;
}

/** `token` is a manage-link token for one booking, or empty to use the WhatsApp-code session (all bookings). */
export function BookingList({ token }: { token: string | null }) {
  const [items, setItems] = useState<Booking[] | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [moving, setMoving] = useState<string | null>(null);
  const [options, setOptions] = useState<{ startAt: string; local: string }[]>([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);

  const [reload, setReload] = useState(0);
  const load = useCallback(async () => {
    setReload((n) => n + 1);
  }, []);
  useEffect(() => {
    let alive = true;
    api<{ bookings: Booking[] }>(`/api/public/manage${token ? `?token=${encodeURIComponent(token)}` : ""}`)
      .then((r) => {
        if (alive) {
          setItems(r.bookings);
          setError("");
        }
      })
      .catch((e) => {
        if (alive) {
          setError(errorMessage(e));
          setItems([]);
        }
      });
    return () => {
      alive = false;
    };
  }, [token, reload]);

  async function cancel(b: Booking) {
    if (!confirm(`Cancel ${b.serviceName} on ${b.startLocal}?`)) return;
    setBusy(true);
    setMsg("");
    setError("");
    try {
      await api("/api/public/manage/cancel", { body: { token, appointmentId: b.appointmentId } });
      setMsg("Your booking has been cancelled.");
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function showTimes(b: Booking) {
    setMoving(b.appointmentId);
    setError("");
    setOptions([]);
    setPick("");
    try {
      const from = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
      const r = await api<{ slots: { startAt: string; local: string }[] }>(
        `/api/public/manage/availability?appointmentId=${b.appointmentId}&from=${from}${token ? `&token=${encodeURIComponent(token)}` : ""}`,
      );
      setOptions(r.slots);
      if (r.slots.length === 0)
        setError("No other times are free with the same masseuse in the next week. Please contact us.");
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function move(b: Booking) {
    setBusy(true);
    setError("");
    setMsg("");
    try {
      await api("/api/public/manage/reschedule", {
        body: { token, appointmentId: b.appointmentId, newStartAt: pick },
      });
      setMsg("Your booking has been moved. A new confirmation is on its way.");
      setMoving(null);
      if (token) {
        setItems(null);
      }
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (items === null)
    return (
      <p role="status" className="mt-4">
        Loading…
      </p>
    );
  return (
    <div className="mt-4 space-y-4">
      {error && <Alert kind="error">{error}</Alert>}
      {msg && <Alert kind="ok">{msg}</Alert>}
      {items.length === 0 && !error && <Alert kind="info">No upcoming bookings.</Alert>}
      {items.map((b) => (
        <section
          key={b.appointmentId}
          className="card space-y-2"
          aria-label={`${b.serviceName} on ${b.startLocal}`}
        >
          <h2 className="text-lg font-semibold">{b.serviceName}</h2>
          <p>
            {b.startLocal}
            <br />
            with {b.staffName ?? "our team"} at {b.branchName}
          </p>
          <p>
            <span className={`badge ${b.status === "confirmed" ? "badge-ok" : "badge-warn"}`}>
              {b.status === "confirmed" ? "Confirmed" : "Awaiting confirmation"}
            </span>
          </p>
          {b.canChange ? (
            <div className="flex flex-wrap gap-2">
              <button className="btn" onClick={() => void showTimes(b)} disabled={busy}>
                Change time
              </button>
              <button className="btn btn-danger" onClick={() => void cancel(b)} disabled={busy}>
                Cancel booking
              </button>
            </div>
          ) : (
            <Alert kind="info">
              This booking is inside the free-change window. Please contact the centre to change or cancel.
            </Alert>
          )}
          {moving === b.appointmentId && options.length > 0 && (
            <div className="space-y-2">
              <SelectField
                label="New time (same masseuse)"
                value={pick}
                onChange={(e) => setPick(e.target.value)}
              >
                <option value="">Choose…</option>
                {options.map((o) => (
                  <option key={o.startAt} value={o.startAt}>
                    {o.local}
                  </option>
                ))}
              </SelectField>
              <button className="btn btn-primary" disabled={!pick || busy} onClick={() => void move(b)}>
                Confirm new time
              </button>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

export function ManageClient({ token }: { token: string }) {
  return <BookingList token={token} />;
}
