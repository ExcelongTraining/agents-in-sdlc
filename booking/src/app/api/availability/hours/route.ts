import { z } from "zod";
import { route } from "@/lib/http/route";
import { decideWorkingHours, hoursSchema, proposeWorkingHours } from "@/lib/services/availability-admin";
import { withTx } from "@/lib/db/tx";
import { staffCtx } from "@/lib/services/schedule";
import { can } from "@/lib/domain/rbac";

export const POST = route({ auth: "staff", body: hoursSchema }, async ({ body, principal }) =>
  proposeWorkingHours(principal!, body),
);
export const PUT = route(
  {
    auth: "staff",
    permission: "availability.approve",
    body: z.object({ batchId: z.uuid(), approve: z.boolean() }),
  },
  async ({ body, principal }) => decideWorkingHours(principal!, body.batchId, body.approve),
);
export const GET = route({ auth: "staff" }, async ({ req, principal }) => {
  const staffId = can(principal!, "availability.manage.all")
    ? (new URL(req.url).searchParams.get("staffId") ?? principal!.staffId)
    : principal!.staffId;
  return {
    windows: await withTx(staffCtx(principal!), (tx) =>
      tx.query(
        "select weekday, start_time::text start, end_time::text \"end\", status from staff_working_hours where staff_id = $1 and status in ('approved','pending') order by status, weekday",
        [staffId],
      ),
    ),
  };
});
