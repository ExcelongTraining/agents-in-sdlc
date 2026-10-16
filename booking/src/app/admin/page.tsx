import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { integrationStatus } from "@/lib/services/admin";

export const metadata: Metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

function List({ rows }: { rows: { status: string; n: number }[] }) {
  return (
    <ul className="mt-1">
      {rows.length ? (
        rows.map((r) => (
          <li key={r.status}>
            {r.status}: <strong>{r.n}</strong>
          </li>
        ))
      ) : (
        <li>none</li>
      )}
    </ul>
  );
}

export default async function Admin() {
  const p = await requireRole(["administrator"]);
  const s = await integrationStatus(p);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Integrations</h1>
      <p className="alert alert-info">
        Administrators see technical status only. Customer details, schedules and message text are not
        available to this role.
      </p>
      <section className="card">
        <h2 className="text-lg font-semibold">
          WhatsApp provider: <span className="badge">{s.provider}</span>
        </h2>
        <ul className="mt-2">
          {Object.entries(s.configured).map(([k, v]) => (
            <li key={k}>
              {k}:{" "}
              {v ? (
                <span className="badge badge-ok">configured</span>
              ) : (
                <span className="badge badge-warn">missing</span>
              )}
            </li>
          ))}
        </ul>
        <p className="hint">
          Secrets are read from server environment variables and are never shown or sent to the browser.
        </p>
      </section>
      <div className="grid gap-3 sm:grid-cols-3">
        <section className="card">
          <h2 className="font-semibold">Notification queue</h2>
          <List rows={s.notificationJobs} />
        </section>
        <section className="card">
          <h2 className="font-semibold">Webhook events</h2>
          <List rows={s.webhookEvents} />
        </section>
        <section className="card">
          <h2 className="font-semibold">Templates</h2>
          <List rows={s.templates} />
        </section>
      </div>
    </div>
  );
}
