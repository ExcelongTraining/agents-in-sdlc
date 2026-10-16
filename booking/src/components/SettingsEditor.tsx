"use client";
import { useState } from "react";
import { Alert, Check, TextField, api } from "./ui";
import { useAction } from "./actions";

type Val = number | boolean | string | null;
const HELP: Record<string, string> = {
  "booking.holdMinutes": "How long a time is held while a customer fills in the form.",
  "booking.minNoticeMinutes": "Customers cannot book sooner than this before the start.",
  "booking.maxAdvanceDays": "Customers cannot book further ahead than this.",
  "booking.slotStepMinutes": "Spacing of offered start times.",
  "booking.changeCutoffHours": "Free cancel/reschedule by customers until this long before the start.",
  "booking.webRequiresApproval": "On: web bookings wait for a manager to confirm.",
  "booking.reminderHoursBefore": "When the WhatsApp reminder is sent.",
  "replacement.requireManagerApproval":
    "On: a replacement needs the manager's approval after the nominee accepts.",
  "replacement.notifyCustomer": "Tell the customer when their masseuse changes.",
  "allocation.windowDays": "Days either side of today counted when sharing 'any available' bookings fairly.",
  "allocation.defaultMaxConsecutiveMinutes":
    "Longest back-to-back stretch before someone is skipped for 'any available' allocation.",
  "allocation.respectCustomerPreference":
    "Returning customers' preferred masseuse is tried first when they choose 'any'.",
  "kpi.hoursBasis": "'scheduled' or 'actual' minutes count towards hours.",
  "kpi.reminderStart": "Earliest time (24h, branch time) for KPI reminders.",
  "kpi.reminderEnd": "Latest time for KPI reminders.",
  "retention.customerInactiveMonths": "Customers with no activity for this long are anonymised.",
  "retention.whatsappMessageDays": "WhatsApp message text is removed after this many days.",
};

export function SettingsEditor({
  initial,
  canEditGroups,
}: {
  initial: Record<string, Record<string, Val>>;
  canEditGroups: string[];
}) {
  const [data, setData] = useState(initial);
  const [reason, setReason] = useState("");
  const [saved, setSaved] = useState("");
  const { error, busy, run } = useAction();
  return (
    <div className="space-y-4">
      {error && <Alert kind="error">{error}</Alert>}
      {saved && <Alert kind="ok">{saved}</Alert>}
      <TextField
        label="Reason for changes (recorded in the audit log)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {Object.entries(data)
        .filter(([g]) => canEditGroups.includes(g))
        .map(([group, vals]) => (
          <form
            key={group}
            className="card space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              setSaved("");
              void run(async () => {
                await api("/api/admin/settings", { method: "PUT", body: { group, value: vals, reason } });
                setSaved(`${group} settings saved.`);
              });
            }}
          >
            <h2 className="text-lg font-semibold capitalize">{group}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {Object.entries(vals).map(([k, v]) => {
                const set = (nv: Val) => setData({ ...data, [group]: { ...vals, [k]: nv } });
                const help = HELP[`${group}.${k}`];
                return typeof v === "boolean" ? (
                  <Check
                    key={k}
                    checked={v}
                    onChange={(e) => set(e.target.checked)}
                    label={
                      <>
                        {k}
                        {help && <span className="hint block">{help}</span>}
                      </>
                    }
                  />
                ) : (
                  <TextField
                    key={k}
                    label={k}
                    hint={help}
                    type={typeof v === "number" || v === null ? "number" : "text"}
                    value={v ?? ""}
                    onChange={(e) =>
                      set(
                        typeof v === "number" || v === null
                          ? e.target.value === ""
                            ? null
                            : Number(e.target.value)
                          : e.target.value,
                      )
                    }
                  />
                );
              })}
            </div>
            <button className="btn btn-primary" disabled={busy || reason.trim().length < 3}>
              Save {group}
            </button>
          </form>
        ))}
    </div>
  );
}
