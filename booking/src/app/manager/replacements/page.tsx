import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { listReplacementHistory } from "@/lib/services/catalog";
import { listStaff } from "@/lib/services/schedule";
import { Approve, NominateForm } from "@/components/actions";

export const metadata: Metadata = { title: "Replacements" };
export const dynamic = "force-dynamic";
const fmt = (d: Date) =>
  d.toLocaleString("en-MY", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kuala_Lumpur" });

export default async function Replacements() {
  const p = await requireRole(["manager"]);
  const [rows, staff] = await Promise.all([listReplacementHistory(p), listStaff(p)]);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Replacement requests</h1>
      <p className="text-sm text-muted">
        Until a change is approved the original masseuse stays assigned. History is kept.
      </p>
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.id} className="card space-y-2">
            <p>
              <strong>{r.requester}</strong> → {r.nominee ?? "no nominee"} · appointment {fmt(r.start_at)}
            </p>
            <p className="text-sm">
              Reason: {r.reason} ·{" "}
              <span
                className={`badge ${["completed"].includes(r.status) ? "badge-ok" : ["failed", "rejected", "declined"].includes(r.status) ? "badge-danger" : "badge-warn"}`}
              >
                {r.status.replaceAll("_", " ")}
              </span>
              {r.failure_reason ? ` (${r.failure_reason})` : ""}
            </p>
            {r.status === "awaiting_manager_approval" && <Approve url={`/api/replacements/${r.id}/decide`} />}
            {r.status === "awaiting_nomination" && (
              <NominateForm id={r.id} staff={staff.filter((s) => s.active)} />
            )}
          </li>
        ))}
        {rows.length === 0 && <li>No replacement requests yet.</li>}
      </ul>
    </div>
  );
}
