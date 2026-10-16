import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { listSchedule, listStaff } from "@/lib/services/schedule";
import { startOfLocalDay } from "@/lib/domain/time";
import { nowMs } from "@/lib/now";
import { Ack, RequestReplacement, StatusButtons } from "@/components/actions";

export const metadata: Metadata = { title: "My schedule" };
export const dynamic = "force-dynamic";
const time = (d: string) =>
  new Date(d).toLocaleTimeString("en-MY", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kuala_Lumpur",
  });
const day = (d: string) =>
  new Date(d).toLocaleDateString("en-MY", {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kuala_Lumpur",
  });

export default async function StaffHome() {
  const p = await requireRole(["masseuse"]);
  const todayIso = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
  const start = startOfLocalDay(todayIso);
  const items = await listSchedule(p, {
    from: start,
    to: new Date(start.getTime() + 14 * 86400_000),
    staffId: p.staffId ?? undefined,
  });
  const colleagues = (await listStaff(p)).filter((s) => s.active && s.id !== p.staffId);
  const today = items.filter((i) => day(i.startAt) === day(new Date().toISOString()));
  const later = items.filter((i) => !today.includes(i));
  const fresh = items.filter((i) => i.isNew).length;
  const now = nowMs();

  const Row = ({ i }: { i: (typeof items)[number] }) => (
    <li className="card space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-lg font-semibold">
            {time(i.startAt)}–{time(i.endAt)} · {i.serviceName}
          </p>
          <p>
            {i.customerName} <span className="text-muted">{i.customerPhone}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {i.isNew && <span className="badge badge-warn">New</span>}
          <span className="badge">{i.status.replaceAll("_", " ")}</span>
          <span className="badge badge-warn">{i.source.replaceAll("_", " ")}</span>
        </div>
      </div>
      {i.note && <p className="text-sm">Note: {i.note}</p>}
      {i.replacementPending && (
        <p className="alert alert-warn">
          A replacement is pending. You remain assigned until the manager approves a change.
        </p>
      )}
      <StatusButtons id={i.id} status={i.status} canStart={new Date(i.startAt).getTime() <= now} />
      {i.status === "confirmed" && new Date(i.startAt).getTime() > now && (
        <RequestReplacement appointmentId={i.id} colleagues={colleagues} />
      )}
    </li>
  );
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Today</h1>
      {fresh > 0 && (
        <div role="status" className="alert alert-warn flex flex-wrap items-center justify-between gap-2">
          <span>
            You have {fresh} newly assigned booking{fresh > 1 ? "s" : ""}.
          </span>
          <Ack />
        </div>
      )}
      {today.length === 0 ? (
        <p>Nothing scheduled today.</p>
      ) : (
        <ul className="space-y-3">
          {today.map((i) => (
            <Row key={i.id} i={i} />
          ))}
        </ul>
      )}
      <h2 className="text-xl font-semibold">Coming up (next 2 weeks)</h2>
      {later.length === 0 ? (
        <p>Nothing else scheduled.</p>
      ) : (
        <ul className="space-y-3">
          {later.map((i, idx) => (
            <li key={i.id} className="space-y-1">
              {(idx === 0 || day(later[idx - 1]!.startAt) !== day(i.startAt)) && (
                <h3 className="font-semibold text-muted">{day(i.startAt)}</h3>
              )}
              <ul>
                <Row i={i} />
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
