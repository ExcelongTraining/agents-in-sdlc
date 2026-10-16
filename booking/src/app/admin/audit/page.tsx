import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { listAudit } from "@/lib/services/admin";

export const metadata: Metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

export default async function Audit() {
  const p = await requireRole(["administrator", "manager"]);
  const rows = await listAudit(p, { limit: 150 });
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">Audit log</h1>
      <p className="text-sm text-muted">
        Append-only. Customer records show changed field names only, never personal values.
      </p>
      <div
        className="overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label="Recent audit events (scrollable)"
      >
        <table className="table">
          <caption className="sr-only">Recent audit events</caption>
          <thead>
            <tr>
              <th scope="col">When (KL)</th>
              <th scope="col">Who</th>
              <th scope="col">Action</th>
              <th scope="col">Entity</th>
              <th scope="col">Change</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">
                  {r.occurred_at.toLocaleString("en-MY", {
                    dateStyle: "short",
                    timeStyle: "medium",
                    timeZone: "Asia/Kuala_Lumpur",
                  })}
                </td>
                <td>
                  {r.actor_kind}
                  {r.actor_user_id ? ` ${r.actor_user_id.slice(0, 8)}` : ""}
                </td>
                <td>{r.action}</td>
                <td>
                  {r.entity_type} {r.entity_id?.slice(0, 8)}
                </td>
                <td className="max-w-md break-words text-xs">
                  {r.after_data ? JSON.stringify(r.after_data).slice(0, 200) : ""}
                </td>
                <td>{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
