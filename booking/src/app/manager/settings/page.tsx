import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { getSettings, listRooms } from "@/lib/services/admin";
import { BusinessHoursEditor, RoomsEditor } from "@/components/BusinessSetup";
import { SettingsEditor } from "@/components/SettingsEditor";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function Settings() {
  const p = await requireRole(["manager"]);
  const [s, rooms] = await Promise.all([getSettings(p), listRooms(p)]);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Settings</h1>
      <p className="text-sm text-muted">Every change is recorded with your name and reason.</p>
      <SettingsEditor
        initial={s as never}
        canEditGroups={["booking", "replacement", "allocation", "kpi", "retention"]}
      />
      <BusinessHoursEditor />
      <RoomsEditor rooms={rooms} />
    </div>
  );
}
