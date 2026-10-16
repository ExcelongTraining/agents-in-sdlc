import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { listStaff } from "@/lib/services/schedule";
import { CalendarView } from "@/components/CalendarView";

export const metadata: Metadata = { title: "Master schedule" };
export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const p = await requireRole(["manager"]);
  const staff = (await listStaff(p)).filter((s) => s.active);
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">Master schedule</h1>
      <p className="text-sm text-muted">
        Drag a confirmed booking to move it. The server checks every rule; a conflict puts it back and tells
        you why.
      </p>
      <CalendarView staff={staff} canEdit />
    </div>
  );
}
