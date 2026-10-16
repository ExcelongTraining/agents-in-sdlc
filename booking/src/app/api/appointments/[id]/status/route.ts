import { z } from "zod";
import { route } from "@/lib/http/route";
import { transitionAppointment } from "@/lib/services/booking";
import { APPOINTMENT_STATUSES } from "@/lib/domain/status";

export const POST = route<
  { to: (typeof APPOINTMENT_STATUSES)[number]; reason?: string; actualMinutes?: number },
  { id: string }
>(
  {
    auth: "staff",
    body: z.object({
      to: z.enum(APPOINTMENT_STATUSES),
      reason: z.string().max(200).optional(),
      actualMinutes: z.number().int().optional(),
    }),
  },
  async ({ params, body, principal }) =>
    transitionAppointment(principal!.orgId, principal!, params.id, body.to, {
      reason: body.reason,
      actualMinutes: body.actualMinutes,
    }),
);
