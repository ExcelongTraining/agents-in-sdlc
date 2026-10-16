import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { listPendingAvailability } from "@/lib/services/availability-admin";
import { listStaff } from "@/lib/services/schedule";
import { Approve } from "@/components/actions";
import { ExceptionForm, HoursEditor } from "@/components/AvailabilityForms";

export const metadata: Metadata = { title: "Availability and leave" };
export const dynamic = "force-dynamic";
const DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const fmt = (d: Date) =>
  d.toLocaleString("en-MY", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kuala_Lumpur" });

export default async function Availability() {
  const p = await requireRole(["manager"]);
  const [pending, staff] = await Promise.all([listPendingAvailability(p), listStaff(p)]);
  const batches = new Map<string, typeof pending.hours>();
  for (const h of pending.hours) batches.set(h.batch_id, [...(batches.get(h.batch_id) ?? []), h]);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Availability & leave</h1>
      <section aria-labelledby="pend">
        <h2 id="pend" className="text-xl font-semibold">
          Waiting for your decision
        </h2>
        {pending.exceptions.length + batches.size === 0 && <p className="mt-2">Nothing waiting.</p>}
        <ul className="mt-2 space-y-2">
          {pending.exceptions.map((e) => (
            <li key={e.id} className="card space-y-2">
              <p>
                <strong>{e.staff}</strong> — {e.kind} {fmt(e.start)} → {fmt(e.end)}
                {e.reason ? ` (${e.reason})` : ""}
              </p>
              <Approve url={`/api/availability/exceptions/${e.id}`} />
              <p className="hint">
                Approval is refused if the period overlaps an existing booking: reassign or cancel it first.
              </p>
            </li>
          ))}
          {[...batches.entries()].map(([batch, rows]) => (
            <li key={batch} className="card space-y-2">
              <p>
                <strong>{rows[0]!.staff}</strong> proposes new weekly hours:{" "}
                {rows
                  .map((r) => `${DAYS[r.weekday]} ${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}`)
                  .join(", ")}
              </p>
              <ApproveHours batchId={batch} />
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="add">
        <h2 id="add" className="text-xl font-semibold">
          Add leave, blocked time, training or closure
        </h2>
        <ExceptionForm staff={staff.filter((s) => s.active)} />
      </section>
      <section aria-labelledby="hrs">
        <h2 id="hrs" className="text-xl font-semibold">
          Weekly working hours
        </h2>
        <HoursEditor staff={staff.filter((s) => s.active)} manager />
      </section>
    </div>
  );
}
function ApproveHours({ batchId }: { batchId: string }) {
  return <Approve url="/api/availability/hours" method="PUT" body={{ batchId }} />;
}
