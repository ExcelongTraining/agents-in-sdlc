import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { listKpiConfig } from "@/lib/services/admin";
import { listStaff } from "@/lib/services/schedule";
import { KpiTargetsClient } from "./KpiTargetsClient";

export const metadata: Metadata = { title: "KPI targets" };
export const dynamic = "force-dynamic";

export default async function KpiConfig() {
  const p = await requireRole(["manager"]);
  const [cfg, staff] = await Promise.all([listKpiConfig(p), listStaff(p)]);
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">KPI targets</h1>
      <p className="text-sm text-muted">
        Targets are settings, not code. A target for &ldquo;everyone&rdquo; applies to all staff unless a
        personal target is set. Changing a target keeps the old one in history.
      </p>
      <KpiTargetsClient
        defs={cfg.definitions}
        targets={cfg.targets.map((t) => ({
          id: t.id,
          definitionId: t.kpi_definition_id,
          staffId: t.staff_id,
          value: t.target_value,
          from: t.valid_from,
        }))}
        staff={staff.filter((s) => s.active)}
      />
    </div>
  );
}
