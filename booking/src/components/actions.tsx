"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, SelectField, TextField, api, errorMessage } from "./ui";

/** Run an API call, show errors inline, refresh the server data. */
export function useAction() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, run, setError };
}

export function Approve({
  url,
  labels = ["Approve", "Decline"],
  body = {},
  method,
}: {
  url: string;
  labels?: [string, string];
  body?: Record<string, unknown>;
  method?: string;
}) {
  const { error, busy, run } = useAction();
  return (
    <div className="space-y-2">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void run(() => api(url, { method, body: { ...body, approve: true } }))}
        >
          {labels[0]}
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => void run(() => api(url, { method, body: { ...body, approve: false } }))}
        >
          {labels[1]}
        </button>
      </div>
    </div>
  );
}

export function RespondButtons({ id }: { id: string }) {
  const { error, busy, run } = useAction();
  return (
    <div className="space-y-2">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void run(() => api(`/api/replacements/${id}/respond`, { body: { accept: true } }))}
        >
          Accept
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => void run(() => api(`/api/replacements/${id}/respond`, { body: { accept: false } }))}
        >
          Decline
        </button>
      </div>
    </div>
  );
}

export function CancelReplacement({ id }: { id: string }) {
  const { error, busy, run } = useAction();
  return (
    <>
      {error && <Alert kind="error">{error}</Alert>}
      <button
        className="btn"
        disabled={busy}
        onClick={() => void run(() => api(`/api/replacements/${id}/cancel`, { body: {} }))}
      >
        Withdraw request
      </button>
    </>
  );
}

export function NominateForm({ id, staff }: { id: string; staff: { id: string; name: string }[] }) {
  const { error, busy, run } = useAction();
  const [who, setWho] = useState("");
  return (
    <div className="space-y-2">
      {error && <Alert kind="error">{error}</Alert>}
      <SelectField label="Choose who to ask" value={who} onChange={(e) => setWho(e.target.value)}>
        <option value="">Select…</option>
        {staff.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </SelectField>
      <button
        className="btn"
        disabled={!who || busy}
        onClick={() =>
          void run(() => api(`/api/replacements/${id}/nominate`, { body: { nomineeStaffId: who } }))
        }
      >
        Ask this person
      </button>
    </div>
  );
}

/** Masseuse: ask to be replaced on an appointment. */
export function RequestReplacement({
  appointmentId,
  colleagues,
}: {
  appointmentId: string;
  colleagues: { id: string; name: string }[];
}) {
  const { error, busy, run, setError } = useAction();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [nominee, setNominee] = useState("");
  if (!open)
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        Request replacement
      </button>
    );
  return (
    <form
      className="card space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api("/api/replacements", {
            body: { appointmentId, reason, nomineeStaffId: nominee || undefined },
          });
          setOpen(false);
        });
      }}
    >
      {error && <Alert kind="error">{error}</Alert>}
      <TextField
        label="Reason"
        required
        minLength={3}
        maxLength={300}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <SelectField
        label="Nominate a colleague (optional)"
        hint="Leave blank and the manager will choose."
        value={nominee}
        onChange={(e) => setNominee(e.target.value)}
      >
        <option value="">Manager chooses</option>
        {colleagues.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </SelectField>
      <p className="hint">Until the change is approved you remain responsible for this appointment.</p>
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={busy}>
          Send request
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setOpen(false);
            setError("");
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function StatusButtons({ id, status, canStart }: { id: string; status: string; canStart: boolean }) {
  const { error, busy, run } = useAction();
  const go = (to: string, label: string, primary = false) => (
    <button
      key={to}
      className={`btn ${primary ? "btn-primary" : ""}`}
      disabled={busy}
      onClick={() => void run(() => api(`/api/appointments/${id}/status`, { body: { to } }))}
    >
      {label}
    </button>
  );
  const buttons = [];
  if (status === "confirmed") buttons.push(go("checked_in", "Check in"), go("in_progress", "Start", true));
  if (status === "checked_in") buttons.push(go("in_progress", "Start", true));
  if ((status === "in_progress" || status === "confirmed") && canStart)
    buttons.push(go("completed", "Complete", status === "in_progress"));
  if (status === "confirmed" && canStart) buttons.push(go("no_show", "No-show"));
  if (!buttons.length) return null;
  return (
    <div className="space-y-2">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="flex flex-wrap gap-2">{buttons}</div>
    </div>
  );
}

export function Ack() {
  const { run, busy } = useAction();
  return (
    <button
      className="btn"
      disabled={busy}
      onClick={() => void run(() => api("/api/schedule/acknowledge", { body: {} }))}
    >
      Mark new bookings as seen
    </button>
  );
}
