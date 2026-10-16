import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { getKpiDashboard } from "@/lib/services/kpi";
import { KpiTable } from "@/components/KpiTable";

export const metadata: Metadata = { title: "My hours and KPIs" };
export const dynamic = "force-dynamic";

export default async function MyKpi() {
  const p = await requireRole(["masseuse"]);
  const { lines } = await getKpiDashboard(p);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">My hours & progress</h1>
      <p className="text-sm text-muted">
        Only you and the manager can see this page. Hours count when an appointment is marked completed.
      </p>
      <KpiTable lines={lines} />
    </div>
  );
}
