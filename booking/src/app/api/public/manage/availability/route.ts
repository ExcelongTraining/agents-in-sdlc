import { z } from "zod";
import { DateTime } from "luxon";
import { route } from "@/lib/http/route";
import { withTx } from "@/lib/db/tx";
import { searchSlots } from "@/lib/services/availability";
import { resolveCustomerAccess } from "@/lib/http/customer";
import { assertOwns } from "@/lib/services/customer-access";
import { formatLocal } from "@/lib/domain/time";

/** Alternative times for the SAME masseuse and service as an existing booking the caller owns. */
export const GET = route(
  { auth: "public", rate: { name: "mavail", limit: 60, windowSeconds: 60 } },
  async ({ req, orgId }) => {
    const sp = new URL(req.url).searchParams;
    const p = z
      .object({ appointmentId: z.uuid(), from: z.iso.date() })
      .parse({ appointmentId: sp.get("appointmentId"), from: sp.get("from") });
    const access = await resolveCustomerAccess(orgId, sp.get("token"));
    return withTx({ kind: "system", orgId, actor: "customer" }, async (tx) => {
      const a = await tx.maybeOne<{
        customer_id: string | null;
        branch_id: string;
        service_id: string;
        staff_id: string | null;
        tz: string;
      }>(
        `select a.customer_id, a.branch_id, a.service_id, g.staff_id, b.timezone tz from appointments a join branches b on b.id = a.branch_id
         left join appointment_assignments g on g.appointment_id = a.id and g.status = 'active' where a.id = $1`,
        [p.appointmentId],
      );
      assertOwns(access, a?.customer_id ?? null, p.appointmentId);
      const to = DateTime.fromISO(p.from).plus({ days: 6 }).toISODate() as string;
      const { slots } = await searchSlots(tx, {
        branchId: a!.branch_id,
        serviceId: a!.service_id,
        fromDate: p.from,
        toDate: to,
        staffId: a!.staff_id ?? undefined,
        now: new Date(),
        enforceNotice: true,
      });
      return {
        slots: slots.map((s) => ({
          startAt: s.startAt.toISOString(),
          local: formatLocal(s.startAt, a!.tz, "EEE d MMM, h:mm a"),
        })),
      };
    });
  },
);
