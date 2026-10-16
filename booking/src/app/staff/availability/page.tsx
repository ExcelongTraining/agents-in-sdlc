import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { withTx } from "@/lib/db/tx";
import { staffCtx } from "@/lib/services/schedule";
import { ExceptionForm, HoursEditor } from "@/components/AvailabilityForms";
import { KpiReminderToggle } from "./KpiReminderToggle";

export const metadata: Metadata = { title: "My availability" };
export const dynamic = "force-dynamic";
const fmt = (d: Date) =>
  d.toLocaleString("en-MY", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kuala_Lumpur" });

export default async function MyAvailability() {
  const p = await requireRole(["masseuse"]);
  const { mine, prefs } = await withTx(staffCtx(p), async (tx) => ({
    mine: await tx.query<{
      id: string;
      kind: string;
      status: string;
      s: Date;
      e: Date;
      reason: string | null;
    }>(
      "select id, kind, status, lower(period) s, upper(period) e, reason from availability_exceptions where staff_id = $1 and upper(period) > now() and status in ('pending','approved') order by lower(period)",
      [p.staffId],
    ),
    prefs: await tx.one<{ kpi_reminders_enabled: boolean }>(
      "select kpi_reminders_enabled from staff_profiles where id = $1",
      [p.staffId],
    ),
  }));
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">My availability</h1>
      <p className="text-sm text-muted">
        Changes to your hours and time off are sent to the manager for approval. Until approved, nothing
        changes for customers.
      </p>
      <section aria-labelledby="off">
        <h2 id="off" className="text-xl font-semibold">
          Request time off or a break
        </h2>
        <ExceptionForm self staff={[]} />
      </section>
      <section aria-labelledby="up">
        <h2 id="up" className="text-xl font-semibold">
          Upcoming time off
        </h2>
        {mine.length === 0 ? (
          <p className="mt-2">None.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {mine.map((m) => (
              <li key={m.id} className="card">
                {m.kind} · {fmt(m.s)} → {fmt(m.e)}{" "}
                <span className={`badge ${m.status === "approved" ? "badge-ok" : "badge-warn"}`}>
                  {m.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="hrs">
        <h2 id="hrs" className="text-xl font-semibold">
          My weekly hours
        </h2>
        <HoursEditor staff={[]} />
      </section>
      <section aria-labelledby="notif">
        <h2 id="notif" className="text-xl font-semibold">
          Notifications
        </h2>
        <KpiReminderToggle staffId={p.staffId!} enabled={prefs.kpi_reminders_enabled} />
      </section>
    </div>
  );
}
