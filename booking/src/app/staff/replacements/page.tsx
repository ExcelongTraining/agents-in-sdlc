import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { listMyReplacements } from "@/lib/services/schedule";
import { CancelReplacement, RespondButtons } from "@/components/actions";

export const metadata: Metadata = { title: "Replacements" };
export const dynamic = "force-dynamic";
const fmt = (d: Date) =>
  d.toLocaleString("en-MY", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kuala_Lumpur" });

export default async function Replacements() {
  const p = await requireRole(["masseuse"]);
  const rows = await listMyReplacements(p);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Replacement requests</h1>
      {rows.length === 0 && <p>Nothing open.</p>}
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.id} className="card space-y-2">
            {r.direction === "incoming" ? (
              <>
                <p>
                  <strong>Can you cover</strong> {r.service} on {fmt(r.start_at)}?
                </p>
                <p className="text-sm">Reason given: {r.reason}</p>
                {r.status === "awaiting_nominee" ? (
                  <RespondButtons id={r.id} />
                ) : (
                  <p>Waiting for the manager.</p>
                )}
              </>
            ) : (
              <>
                <p>
                  You asked to be replaced on {r.service}, {fmt(r.start_at)}.
                </p>
                <p className="text-sm">
                  Status: <span className="badge">{r.status.replaceAll("_", " ")}</span>. You stay assigned
                  until it is approved.
                </p>
                <CancelReplacement id={r.id} />
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
