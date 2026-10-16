import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/http/guard";
import { managerDashboard, listSchedule } from "@/lib/services/schedule";
import { startOfLocalDay } from "@/lib/domain/time";
import { Approve, NominateForm } from "@/components/actions";
import { listStaff } from "@/lib/services/schedule";

export const metadata: Metadata = { title: "Manager dashboard" };
export const dynamic = "force-dynamic";

const fmt = (d: string) =>
  new Date(d).toLocaleString("en-MY", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kuala_Lumpur",
  });

export default async function Dashboard() {
  const p = await requireRole(["manager"]);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
  const start = startOfLocalDay(today);
  const end = new Date(start.getTime() + 86400_000);
  const [d, items, staff] = await Promise.all([
    managerDashboard(p, start, end),
    listSchedule(p, { from: start, to: end }),
    listStaff(p),
  ]);
  const alerts: { kind: string; text: string }[] = [];
  if (d.openReplacements.length)
    alerts.push({ kind: "warn", text: `${d.openReplacements.length} replacement request(s) open` });
  if (d.pendingConfirmation)
    alerts.push({ kind: "warn", text: `${d.pendingConfirmation} booking(s) awaiting your confirmation` });
  if (d.humanHandoffs)
    alerts.push({ kind: "warn", text: `${d.humanHandoffs} WhatsApp chat(s) waiting for a person` });
  if (d.unacknowledged)
    alerts.push({
      kind: "warn",
      text: `${d.unacknowledged} assignment(s) not yet seen by the masseuse for over an hour`,
    });
  if (d.deadLetters)
    alerts.push({
      kind: "error",
      text: `${d.deadLetters} notification(s) could not be delivered in the last 7 days`,
    });
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Today</h1>
      {alerts.length > 0 && (
        <section aria-label="Operational alerts" className="space-y-2">
          {alerts.map((a) => (
            <div key={a.text} role="status" className={`alert alert-${a.kind}`}>
              {a.text}
            </div>
          ))}
        </section>
      )}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Summary">
        <div className="card">
          <p className="text-sm text-muted">Appointments today</p>
          <p className="text-3xl font-bold">{d.todayCount}</p>
        </div>
        <div className="card">
          <p className="text-sm text-muted">Awaiting confirmation</p>
          <p className="text-3xl font-bold">{d.pendingConfirmation}</p>
        </div>
        <div className="card">
          <p className="text-sm text-muted">Slots currently held</p>
          <p className="text-3xl font-bold">{d.activeHolds}</p>
        </div>
        <div className="card">
          <p className="text-sm text-muted">Failed notifications</p>
          <p className="text-3xl font-bold">{d.failedNotifications}</p>
        </div>
      </section>

      <section aria-labelledby="staff-today">
        <h2 id="staff-today" className="text-xl font-semibold">
          Staff today
        </h2>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {d.staffToday.map((s) => (
            <li key={s.staffId} className="card flex justify-between">
              <span>{s.name}</span>
              <span>
                {s.onLeave ? (
                  <span className="badge badge-warn">On leave / blocked</span>
                ) : (
                  `${s.appointments} appt`
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="repl">
        <h2 id="repl" className="text-xl font-semibold">
          Replacement requests
        </h2>
        {d.openReplacements.length === 0 ? (
          <p className="mt-2">None open.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {d.openReplacements.map((r) => (
              <li key={r.id} className="card space-y-2">
                <p>
                  <strong>{r.requester}</strong> asks to be replaced on {fmt(r.startAt)} — {r.reason}
                </p>
                <p className="text-sm">
                  Nominee: {r.nominee ?? "none yet"} ·{" "}
                  <span className="badge">{r.status.replaceAll("_", " ")}</span>
                </p>
                {r.status === "awaiting_manager_approval" && (
                  <Approve url={`/api/replacements/${r.id}/decide`} />
                )}
                {r.status === "awaiting_nomination" && (
                  <NominateForm id={r.id} staff={staff.filter((s) => s.active)} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="sched">
        <div className="flex items-center justify-between">
          <h2 id="sched" className="text-xl font-semibold">
            Today&rsquo;s appointments
          </h2>
          <Link href="/manager/calendar" className="btn">
            Open master schedule
          </Link>
        </div>
        {items.length === 0 ? (
          <p className="mt-2">No appointments today.</p>
        ) : (
          <div
            className="mt-2 overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Today’s appointments (scrollable)"
          >
            <table className="table">
              <caption className="sr-only">Today&rsquo;s appointments</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Masseuse</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Service</th>
                  <th scope="col">Source</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {new Date(i.startAt).toLocaleTimeString("en-MY", {
                        hour: "numeric",
                        minute: "2-digit",
                        timeZone: "Asia/Kuala_Lumpur",
                      })}
                    </td>
                    <td>{i.staffName}</td>
                    <td>
                      {i.customerName}
                      <br />
                      <span className="text-muted">{i.customerPhone}</span>
                    </td>
                    <td>{i.serviceName}</td>
                    <td>{i.source.replaceAll("_", " ")}</td>
                    <td>
                      <span className="badge">{i.status.replaceAll("_", " ")}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
