import { z } from "zod";
import { route } from "@/lib/http/route";
import { operationsReport } from "@/lib/services/reports";

export const GET = route({ auth: "staff", permission: "kpi.read.all" }, async ({ req, principal }) => {
  const p = z
    .object({ from: z.coerce.date(), to: z.coerce.date() })
    .parse(Object.fromEntries(new URL(req.url).searchParams));
  return operationsReport(principal!, p.from, p.to);
});
