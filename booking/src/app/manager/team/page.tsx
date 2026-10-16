import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { listUsers } from "@/lib/services/admin";
import { withTx } from "@/lib/db/tx";
import { staffCtx } from "@/lib/services/schedule";
import { TeamClient } from "./TeamClient";

export const metadata: Metadata = { title: "Team" };
export const dynamic = "force-dynamic";

export default async function Team() {
  const p = await requireRole(["manager"]);
  const users = await listUsers(p);
  const profiles = await withTx(staffCtx(p), (tx) =>
    tx.query<{
      id: string;
      active: boolean;
      can_take_direct_bookings: boolean;
      kpi_reminders_enabled: boolean;
      fairness_weight: number;
      max_consecutive_minutes: number | null;
      phone_e164: string | null;
    }>(
      "select id, active, can_take_direct_bookings, kpi_reminders_enabled, fairness_weight::float fairness_weight, max_consecutive_minutes, phone_e164 from staff_profiles",
    ),
  );
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Team & access</h1>
      <TeamClient
        currentUserId={p.userId}
        users={users.map((u) => ({
          id: u.id,
          name: u.display_name,
          email: u.email,
          status: u.status,
          roles: u.roles,
          staffId: u.staff_id,
          lastLogin: u.last_login_at?.toISOString() ?? null,
        }))}
        profiles={profiles}
      />
    </div>
  );
}
