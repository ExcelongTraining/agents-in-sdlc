import { z } from "zod";
import { route } from "@/lib/http/route";
import { rescheduleAppointment } from "@/lib/services/booking";
import { resolveCustomerAccess } from "@/lib/http/customer";
import { assertOwns } from "@/lib/services/customer-access";
import { withTx } from "@/lib/db/tx";

export const POST = route(
  {
    auth: "public",
    body: z.object({
      token: z.string().nullable().optional(),
      appointmentId: z.uuid(),
      newStartAt: z.iso.datetime(),
    }),
    rate: { name: "resched", limit: 10, windowSeconds: 600 },
  },
  async ({ body, orgId }) => {
    const access = await resolveCustomerAccess(orgId, body.token ?? null);
    const owner = await withTx({ kind: "system", orgId, actor: "customer" }, (tx) =>
      tx.maybeOne<{ customer_id: string | null }>("select customer_id from appointments where id = $1", [
        body.appointmentId,
      ]),
    );
    assertOwns(access, owner?.customer_id ?? null, body.appointmentId);
    return rescheduleAppointment(
      orgId,
      { kind: "customer", customerId: access.customerId, via: body.token ? "manage_token" : "otp" },
      { appointmentId: body.appointmentId, newStartAt: new Date(body.newStartAt) },
    );
  },
);
