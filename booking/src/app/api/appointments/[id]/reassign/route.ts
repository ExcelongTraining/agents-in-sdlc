import { z } from "zod";
import { route } from "@/lib/http/route";
import { reassignAppointment, overrideSchema } from "@/lib/services/booking";

export const POST = route<
  { newStaffId: string; reason: string; override?: z.infer<typeof overrideSchema> },
  { id: string }
>(
  {
    auth: "staff",
    permission: "appointment.assign",
    body: z.object({
      newStaffId: z.uuid(),
      reason: z.string().min(3).max(200),
      override: overrideSchema.optional(),
    }),
  },
  async ({ params, body, principal }) =>
    reassignAppointment(principal!, { appointmentId: params.id, ...body }),
);
