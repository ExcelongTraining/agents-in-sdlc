"use client";
import { useMemo, useRef, useState } from "react";
import {
  Alert,
  Check,
  SelectField,
  TextAreaField,
  TextField,
  api,
  errorMessage,
  newKey,
} from "@/components/ui";

export interface FormService {
  id: string;
  name: string;
  kind: string;
  durationMinutes: number;
  staffIds: string[];
}
export interface FormStaff {
  id: string;
  name: string;
}
interface Slot {
  startAt: string;
  local: string;
  staff: { id: string; name: string }[];
}

const todayKL = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });

/** Telephone / walk-in / masseuse-recorded bookings. Same availability engine and database rules as the public flow. */
export function BookingForm({
  mode,
  branchId,
  services,
  staff,
  selfStaffId,
}: {
  mode: "manager" | "staff";
  branchId: string;
  services: FormService[];
  staff: FormStaff[];
  selfStaffId?: string;
}) {
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [staffId, setStaffId] = useState(mode === "staff" ? (selfStaffId ?? "") : "any");
  const [source, setSource] = useState<string>(mode === "staff" ? "staff_direct" : "phone");
  const [date, setDate] = useState(todayKL());
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [startAt, setStartAt] = useState("");
  const [custom, setCustom] = useState("");
  const [f, setF] = useState({ name: "", phone: "", email: "", note: "", consent: false, whatsapp: false });
  const [override, setOverride] = useState(false);
  const [rules, setRules] = useState<string[]>(["working_hours"]);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());

  const service = services.find((s) => s.id === serviceId);
  const eligibleStaff = useMemo(
    () => staff.filter((s) => service?.staffIds.includes(s.id)),
    [staff, service],
  );

  async function find() {
    setBusy(true);
    setError("");
    setSlots(null);
    setStartAt("");
    try {
      setSlots(
        (
          await api<{ slots: Slot[] }>(
            `/api/appointments/search?branchId=${branchId}&serviceId=${serviceId}&staffId=${staffId}&from=${date}`,
          )
        ).slots,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const when = custom ? new Date(`${custom}:00+08:00`).toISOString() : startAt; // custom is a Kuala Lumpur wall-clock time
    if (!when) {
      setError("Choose a time or enter a custom time.");
      return;
    }
    setBusy(true);
    setError("");
    setResult("");
    try {
      const r = await api<{ staffName: string; serviceName: string; startAt: string }>("/api/appointments", {
        body: {
          branchId,
          serviceId,
          startAt: when,
          staffId,
          source,
          customer: { name: f.name, phone: f.phone, email: f.email },
          consent: { serviceBooking: true, whatsapp: f.whatsapp, marketing: false },
          note: f.note || undefined,
          override: override ? { rules, reason } : undefined,
          idempotencyKey: key.current,
        },
      });
      setResult(
        `Booked ${r.serviceName} with ${r.staffName} on ${new Date(r.startAt).toLocaleString("en-MY", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kuala_Lumpur" })}.`,
      );
      key.current = newKey();
      setF({ name: "", phone: "", email: "", note: "", consent: false, whatsapp: false });
      setSlots(null);
      setStartAt("");
      setCustom("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card max-w-2xl space-y-4">
      {error && <Alert kind="error">{error}</Alert>}
      {result && <Alert kind="ok">{result}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Service"
          value={serviceId}
          onChange={(e) => {
            setServiceId(e.target.value);
            setSlots(null);
          }}
        >
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.durationMinutes} min)
            </option>
          ))}
        </SelectField>
        {mode === "manager" ? (
          <SelectField
            label="Masseuse"
            value={staffId}
            onChange={(e) => {
              setStaffId(e.target.value);
              setSlots(null);
            }}
          >
            <option value="any">Any available (fair allocation)</option>
            {eligibleStaff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectField>
        ) : (
          <p className="self-end pb-2 text-sm">Recording for yourself.</p>
        )}
        {mode === "manager" && (
          <SelectField label="Booking source" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="phone">Telephone</option>
            <option value="walk_in">Walk-in</option>
            <option value="manager">Other (manager)</option>
          </SelectField>
        )}
        <TextField
          label="Date"
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setSlots(null);
          }}
        />
      </div>
      <button type="button" className="btn" onClick={() => void find()} disabled={busy || !serviceId}>
        Find free times
      </button>

      {slots && (
        <fieldset>
          <legend className="label">Free times</legend>
          {slots.length === 0 ? (
            <p>
              No free times that day. You can still enter a custom time below
              {mode === "manager" ? " (an override may be needed)" : ""}.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {slots.map((s) => (
                <label
                  key={s.startAt}
                  className={`btn ${startAt === s.startAt && !custom ? "btn-primary" : ""}`}
                >
                  <input
                    type="radio"
                    name="slot"
                    className="sr-only"
                    checked={startAt === s.startAt && !custom}
                    onChange={() => {
                      setStartAt(s.startAt);
                      setCustom("");
                    }}
                  />
                  {s.local.split(", ")[1]}
                  {staffId === "any" && s.staff.length === 1 ? ` · ${s.staff[0]!.name}` : ""}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}
      <TextField
        label="Or a custom start time"
        type="datetime-local"
        hint="Walk-ins starting now, or a time outside the grid. Local time (Kuala Lumpur)."
        value={custom}
        onChange={(e) => setCustom(e.target.value)}
      />

      <fieldset className="space-y-3">
        <legend className="label">Customer</legend>
        <TextField
          label="Name"
          required
          value={f.name}
          maxLength={100}
          onChange={(e) => setF({ ...f, name: e.target.value })}
        />
        <TextField
          label="Mobile number"
          required
          type="tel"
          value={f.phone}
          onChange={(e) => setF({ ...f, phone: e.target.value })}
        />
        <TextField
          label="E-mail (optional)"
          type="email"
          value={f.email}
          onChange={(e) => setF({ ...f, email: e.target.value })}
        />
        <TextAreaField
          label="Operational note (optional)"
          maxLength={500}
          hint="No health information."
          value={f.note}
          onChange={(e) => setF({ ...f, note: e.target.value })}
        />
        <Check
          required
          checked={f.consent}
          onChange={(e) => setF({ ...f, consent: e.target.checked })}
          label="I have told the customer how their details are used (privacy notice) and they agree. (Required)"
        />
        <Check
          checked={f.whatsapp}
          onChange={(e) => setF({ ...f, whatsapp: e.target.checked })}
          label="Customer agrees to receive WhatsApp confirmations and reminders."
        />
      </fieldset>

      {mode === "manager" && (
        <fieldset className="space-y-3 rounded-lg border border-line p-3">
          <legend className="label px-1">Manager override (audited)</legend>
          <Check
            checked={override}
            onChange={(e) => setOverride(e.target.checked)}
            label="Override selected rules for this booking"
          />
          {override && (
            <>
              <div className="flex flex-wrap gap-4">
                {[
                  ["working_hours", "Staff working hours"],
                  ["business_hours", "Business hours"],
                  ["break", "Break time"],
                ].map(([k, l]) => (
                  <Check
                    key={k}
                    checked={rules.includes(k!)}
                    onChange={(e) =>
                      setRules(e.target.checked ? [...rules, k!] : rules.filter((r) => r !== k))
                    }
                    label={l}
                  />
                ))}
              </div>
              <TextField
                label="Reason (required, recorded in the audit log)"
                required
                minLength={5}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <p className="hint">Double-booking, leave and qualification can never be overridden.</p>
            </>
          )}
        </fieldset>
      )}
      <button className="btn btn-primary" disabled={busy || !f.consent}>
        {busy ? "Saving…" : "Create booking"}
      </button>
    </form>
  );
}
