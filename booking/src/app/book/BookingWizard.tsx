"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nowMs } from "@/lib/now";
import {
  Alert,
  Check,
  SelectField,
  TextAreaField,
  TextField,
  api,
  errorMessage,
  newKey,
  ApiError,
} from "@/components/ui";

interface Service {
  id: string;
  name: string;
  description: string | null;
  kind: "service" | "trial" | "consultation";
  durationMinutes: number;
  priceMyr: number | null;
  branchId: string | null;
  staff: { id: string; name: string }[];
}
interface Catalog {
  branches: { id: string; name: string }[];
  services: Service[];
  policy: { holdMinutes: number; changeCutoffHours: number };
}
interface Slot {
  startAt: string;
  local: string;
  date: string;
  hour: number;
  staff: { id: string; name: string }[];
}
interface Hold {
  holdToken: string;
  expiresAt: string;
  startAt: string;
  serviceName: string;
  staffName: string;
  staffId: string;
}
interface Done {
  appointmentId: string;
  manageToken: string;
  serviceName: string;
  staffName: string;
  startAt: string;
  status: string;
}

const NOTICE_VERSION = "2026-01";
const todayKL = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
const fmtDate = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-MY", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const fmtLong = (iso: string) =>
  new Date(iso).toLocaleString("en-MY", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kuala_Lumpur",
  });
const RANGES = { any: [0, 24], morning: [0, 12], afternoon: [12, 17], evening: [17, 24] } as const;

export function BookingWizard() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [step, setStep] = useState<"type" | "who" | "when" | "details" | "done">("type");
  const [visit, setVisit] = useState<"new" | "returning">("new");
  const [intent, setIntent] = useState<"service" | "trial" | "consultation">("service");
  const [chosenServiceId, setServiceId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [staffId, setStaffId] = useState("any");
  const [from, setFrom] = useState(todayKL());
  const [range, setRange] = useState<keyof typeof RANGES>("any");
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [day, setDay] = useState("");
  const [hold, setHold] = useState<Hold | null>(null);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Done | null>(null);
  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    note: "",
    privacy: false,
    whatsapp: true,
    marketing: false,
  });
  const confirmKey = useRef(newKey());
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    api<Catalog>("/api/public/catalog")
      .then((c) => {
        setCatalog(c);
        setBranchId(c.branches[0]?.id ?? "");
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  useEffect(() => {
    if (!hold) return;
    const tick = () => setNow(nowMs());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [hold]);

  const services = useMemo(
    () =>
      (catalog?.services ?? []).filter((s) => s.kind === intent && (!s.branchId || s.branchId === branchId)),
    [catalog, intent, branchId],
  );
  const serviceId = services.some((s) => s.id === chosenServiceId)
    ? chosenServiceId
    : (services[0]?.id ?? "");
  const service = catalog?.services.find((s) => s.id === serviceId);
  const staffName = (id: string) => service?.staff.find((s) => s.id === id)?.name ?? "";

  const search = useCallback(async () => {
    if (!serviceId || !branchId) return;
    setBusy(true);
    setError("");
    setSlots(null);
    try {
      const r = await api<{ slots: Slot[] }>(
        `/api/public/availability?branchId=${branchId}&serviceId=${serviceId}&staffId=${staffId}&from=${from}&days=7`,
      );
      setSlots(r.slots);
      setDay(r.slots[0]?.date ?? "");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [serviceId, branchId, staffId, from]);

  const days = useMemo(() => [...new Set((slots ?? []).map((s) => s.date))], [slots]);
  const visible = useMemo(() => {
    const [lo, hi] = RANGES[range];
    return (slots ?? []).filter((s) => s.date === day && s.hour >= lo && s.hour < hi);
  }, [slots, day, range]);

  async function choose(slot: Slot) {
    setBusy(true);
    setError("");
    try {
      const h = await api<Hold>("/api/public/holds", {
        body: { branchId, serviceId, startAt: slot.startAt, staffId, idempotencyKey: newKey() },
      });
      confirmKey.current = newKey();
      setHold(h);
      setNow(nowMs());
      setStep("details");
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.code === "SLOT_TAKEN") void search();
    } finally {
      setBusy(false);
    }
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!hold) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<Done>("/api/public/bookings", {
        body: {
          holdToken: hold.holdToken,
          customer: { name: form.name, phone: form.phone, email: form.email },
          note: form.note || undefined,
          consent: { serviceBooking: true, whatsapp: form.whatsapp, marketing: form.marketing },
          noticeVersion: NOTICE_VERSION,
          idempotencyKey: confirmKey.current,
        },
      });
      setDone(r);
      setHold(null);
      setStep("done");
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.code === "HOLD_EXPIRED") {
        setHold(null);
        setStep("when");
        void search();
      }
    } finally {
      setBusy(false);
    }
  }

  async function joinWaitlist() {
    if (!form.name || !form.phone) {
      setError("Enter your name and phone number below to join the wait-list.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const start = new Date(`${from}T00:00:00+08:00`);
      await api("/api/public/waitlist", {
        body: {
          branchId,
          serviceId,
          preferredStaffId: staffId === "any" ? undefined : staffId,
          windowStart: start.toISOString(),
          windowEnd: new Date(start.getTime() + 14 * 86400_000).toISOString(),
          customer: { name: form.name, phone: form.phone },
          consent: { serviceBooking: true, whatsapp: form.whatsapp },
          noticeVersion: NOTICE_VERSION,
        },
      });
      setError("");
      alert("You are on the wait-list. We will message you if a time opens up.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!catalog)
    return (
      <div className="mt-4">
        {error ? <Alert kind="error">{error}</Alert> : <p role="status">Loading…</p>}
      </div>
    );
  const remaining =
    hold && now
      ? Math.max(0, Math.floor((Date.parse(hold.expiresAt) - now) / 1000))
      : hold
        ? Math.floor((catalog.policy.holdMinutes ?? 10) * 60)
        : 0;

  return (
    <div className="mt-4 space-y-4">
      <ol className="flex flex-wrap gap-2 text-sm" aria-label="Progress">
        {[
          ["type", "1. Service"],
          ["who", "2. Masseuse"],
          ["when", "3. Time"],
          ["details", "4. Details"],
        ].map(([k, l]) => (
          <li
            key={k}
            className={`badge ${step === k ? "" : "badge-warn"}`}
            aria-current={step === k ? "step" : undefined}
          >
            {l}
          </li>
        ))}
      </ol>
      {error && <Alert kind="error">{error}</Alert>}

      {step === "type" && (
        <section className="card space-y-4">
          <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">
            What would you like to book?
          </h2>
          <fieldset>
            <legend className="label">Have you visited us before?</legend>
            <div className="flex gap-4">
              {(["new", "returning"] as const).map((v) => (
                <label key={v} className="flex min-h-11 items-center gap-2">
                  <input
                    type="radio"
                    name="visit"
                    checked={visit === v}
                    onChange={() => {
                      setVisit(v);
                      if (v === "new") setIntent("trial");
                    }}
                    className="h-5 w-5 accent-[var(--brand)]"
                  />
                  {v === "new" ? "This is my first visit" : "I'm a returning customer"}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="label">I would like</legend>
            <div className="space-y-1">
              {(
                [
                  ["service", "A massage / service"],
                  ["trial", "A first-time trial"],
                  ["consultation", "A consultation only (no treatment)"],
                ] as const
              ).map(([k, l]) => (
                <label key={k} className="flex min-h-11 items-center gap-2">
                  <input
                    type="radio"
                    name="intent"
                    checked={intent === k}
                    onChange={() => setIntent(k)}
                    className="h-5 w-5 accent-[var(--brand)]"
                  />
                  {l}
                </label>
              ))}
            </div>
          </fieldset>
          {catalog.branches.length > 1 && (
            <SelectField label="Branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              {catalog.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </SelectField>
          )}
          {services.length === 0 ? (
            <Alert kind="info">Nothing of this type is bookable online right now. Please contact us.</Alert>
          ) : (
            <SelectField label="Service" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {s.durationMinutes} min{s.priceMyr ? ` — RM${s.priceMyr}` : ""}
                </option>
              ))}
            </SelectField>
          )}
          {service?.description && <p className="hint">{service.description}</p>}
          <button
            className="btn btn-primary"
            disabled={!serviceId}
            onClick={() => {
              setStaffId("any");
              setStep("who");
            }}
          >
            Continue
          </button>
        </section>
      )}

      {step === "who" && service && (
        <section className="card space-y-4">
          <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">
            Who would you like?
          </h2>
          <fieldset>
            <legend className="sr-only">Masseuse</legend>
            <div className="space-y-1">
              {[{ id: "any", name: "Any available masseuse" }, ...service.staff].map((s) => (
                <label key={s.id} className="flex min-h-11 items-center gap-2">
                  <input
                    type="radio"
                    name="staff"
                    checked={staffId === s.id}
                    onChange={() => setStaffId(s.id)}
                    className="h-5 w-5 accent-[var(--brand)]"
                  />
                  {s.name}
                </label>
              ))}
            </div>
          </fieldset>
          <p className="hint">
            If your preferred masseuse is busy we will show you other times with her and other masseuses at
            your time. We never assign someone else without asking.
          </p>
          <div className="flex gap-2">
            <button className="btn" onClick={() => setStep("type")}>
              Back
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                setStep("when");
                void search();
              }}
            >
              Show available times
            </button>
          </div>
        </section>
      )}

      {step === "when" && service && (
        <section className="card space-y-4" aria-busy={busy}>
          <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">
            Choose a time
          </h2>
          <p className="text-sm">
            {service.name} · {staffId === "any" ? "any available masseuse" : staffName(staffId)}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="From date"
              type="date"
              value={from}
              min={todayKL()}
              max={addDays(todayKL(), 90)}
              onChange={(e) => setFrom(e.target.value)}
            />
            <SelectField
              label="Time of day"
              value={range}
              onChange={(e) => setRange(e.target.value as keyof typeof RANGES)}
            >
              <option value="any">Any time</option>
              <option value="morning">Morning</option>
              <option value="afternoon">Afternoon (12–5 pm)</option>
              <option value="evening">Evening (after 5 pm)</option>
            </SelectField>
          </div>
          <button className="btn" onClick={() => void search()} disabled={busy}>
            {busy ? "Searching…" : "Update times"}
          </button>
          {slots && slots.length === 0 && (
            <div className="space-y-2">
              <Alert kind="warn">
                No free times in the next 7 days{staffId !== "any" ? ` with ${staffName(staffId)}` : ""}.
              </Alert>
              <div className="flex flex-wrap gap-2">
                {staffId !== "any" && (
                  <button
                    className="btn"
                    onClick={() => {
                      setStaffId("any");
                      setTimeout(() => void search(), 0);
                    }}
                  >
                    Try any available masseuse
                  </button>
                )}
                <button
                  className="btn"
                  onClick={() => {
                    setFrom(addDays(from, 7));
                    setTimeout(() => void search(), 0);
                  }}
                >
                  Look a week later
                </button>
                <button className="btn" onClick={() => setStep("details")}>
                  Join the wait-list
                </button>
              </div>
            </div>
          )}
          {slots && slots.length > 0 && (
            <>
              <div role="tablist" aria-label="Day" className="flex flex-wrap gap-2">
                {days.map((d) => (
                  <button
                    key={d}
                    role="tab"
                    aria-selected={d === day}
                    className={`btn ${d === day ? "btn-primary" : ""}`}
                    onClick={() => setDay(d)}
                  >
                    {fmtDate(d)}
                  </button>
                ))}
              </div>
              {visible.length === 0 ? (
                <p>No times in that part of the day. Try &ldquo;Any time&rdquo;.</p>
              ) : (
                <ul
                  className="grid grid-cols-2 gap-2 sm:grid-cols-3"
                  aria-label={`Available times on ${fmtDate(day)}`}
                >
                  {visible.map((s) => (
                    <li key={s.startAt}>
                      <button
                        className="btn w-full flex-col"
                        disabled={busy}
                        onClick={() => void choose(s)}
                        aria-label={`${s.local}${staffId === "any" ? `, ${s.staff.length} masseuse${s.staff.length > 1 ? "s" : ""} available` : ""}`}
                      >
                        <span>{s.local}</span>
                        {staffId === "any" && s.staff.length === 1 && (
                          <span className="text-xs font-normal text-muted">{s.staff[0]!.name}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <button className="btn" onClick={() => setStep("who")}>
            Back
          </button>
        </section>
      )}

      {step === "details" && service && (
        <form onSubmit={submit} className="card space-y-4" noValidate={false}>
          <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">
            {hold ? "Your details" : "Join the wait-list"}
          </h2>
          {hold && (
            <Alert kind={remaining < 60 ? "warn" : "info"}>
              Holding <strong>{fmtLong(hold.startAt)}</strong> with <strong>{hold.staffName}</strong> for{" "}
              {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}.
              {remaining === 0 && " The hold has expired; please choose a time again."}
            </Alert>
          )}
          <TextField
            label="Name"
            required
            autoComplete="name"
            maxLength={100}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <TextField
            label="Mobile number"
            required
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            hint="For example 012-345 6789"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
          {hold && (
            <>
              <TextField
                label="E-mail (optional)"
                type="email"
                autoComplete="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
              <TextAreaField
                label="Note for the team (optional)"
                maxLength={500}
                hint="Please do not include health information."
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </>
          )}
          <fieldset className="space-y-3">
            <legend className="label">Consent</legend>
            <Check
              required={!!hold}
              checked={form.privacy}
              onChange={(e) => setForm({ ...form, privacy: e.target.checked })}
              label={
                <>
                  I have read the{" "}
                  <Link href="/privacy" target="_blank" className="underline">
                    privacy notice
                  </Link>{" "}
                  and agree that the centre may store my name, phone number and booking details to arrange my
                  appointment. (Required)
                </>
              }
            />
            <Check
              checked={form.whatsapp}
              onChange={(e) => setForm({ ...form, whatsapp: e.target.checked })}
              label="Send my confirmation and reminders on WhatsApp. Reply STOP any time to stop."
            />
            <Check
              checked={form.marketing}
              onChange={(e) => setForm({ ...form, marketing: e.target.checked })}
              label="Send me occasional offers (optional)."
            />
          </fieldset>
          <p className="hint">
            Free changes and cancellation up to {catalog.policy.changeCutoffHours} hours before your
            appointment.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setHold(null);
                setStep("when");
                void search();
              }}
            >
              Back
            </button>
            {hold ? (
              <button className="btn btn-primary" disabled={busy || remaining === 0 || !form.privacy}>
                {busy ? "Booking…" : "Confirm booking"}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !form.privacy}
                onClick={() => void joinWaitlist()}
              >
                Join wait-list
              </button>
            )}
          </div>
        </form>
      )}

      {step === "done" && done && (
        <section className="card space-y-3" aria-live="polite">
          <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">
            {done.status === "confirmed" ? "You're booked" : "Request received"}
          </h2>
          <p>
            <strong>{done.serviceName}</strong> with <strong>{done.staffName}</strong>
            <br />
            {fmtLong(done.startAt)}
          </p>
          {done.status !== "confirmed" && <Alert kind="info">We will confirm your request shortly.</Alert>}
          <p>
            {form.whatsapp
              ? "A confirmation is on its way to your WhatsApp."
              : "Keep this page or the link below: we will not send WhatsApp messages."}
          </p>
          <p>
            <Link className="btn btn-primary" href={`/manage/${done.manageToken}`}>
              Change or cancel this booking
            </Link>
          </p>
          <p className="hint">
            Save the link above: it is the only way to manage this booking without signing in. Anyone with the
            link can change or cancel it.
          </p>
        </section>
      )}
    </div>
  );
}
