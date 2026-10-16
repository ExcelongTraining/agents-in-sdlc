"use client";
import { Alert, Check, api } from "@/components/ui";
import { useAction } from "@/components/actions";

export function KpiReminderToggle({ staffId, enabled }: { staffId: string; enabled: boolean }) {
  const { error, busy, run } = useAction();
  return (
    <div className="space-y-2">
      {error && <Alert kind="error">{error}</Alert>}
      <Check
        disabled={busy}
        checked={enabled}
        onChange={(e) =>
          void run(() =>
            api("/api/admin/users", {
              method: "PATCH",
              body: { staff: { id: staffId, kpiRemindersEnabled: e.target.checked } },
            }),
          )
        }
        label="Send me a weekly progress reminder on WhatsApp (only about my own hours, during the daytime)"
      />
    </div>
  );
}
