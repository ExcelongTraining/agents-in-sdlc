import { route } from "@/lib/http/route";
import { kpiTargetInput, setKpiTarget } from "@/lib/services/admin";

export const PUT = route(
  { auth: "staff", permission: "kpi.configure", body: kpiTargetInput },
  async ({ body, principal }) => {
    await setKpiTarget(principal!, body);
    return { ok: true };
  },
);
