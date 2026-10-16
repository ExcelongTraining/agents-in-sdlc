import { route } from "@/lib/http/route";
import { getKpiDashboard } from "@/lib/services/kpi";

export const GET = route({ auth: "staff" }, async ({ req, principal }) =>
  getKpiDashboard(principal!, { staffId: new URL(req.url).searchParams.get("staffId") ?? undefined }),
);
