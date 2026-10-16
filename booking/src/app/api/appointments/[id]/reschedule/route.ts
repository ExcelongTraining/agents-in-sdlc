import { z } from "zod";
import { route } from "@/lib/http/route";
import { rescheduleAppointment, overrideSchema } from "@/lib/services/booking";

export const POST = route<
  { newStartAt: string; newStaffId?: string; reason?: string; override?: z.infer<typeof overrideSchema> },
  { id: string }
>(
  {
    auth: "staff",
    permission: "appointment.transition.any",
    body: z.object({
      newStartAt: z.iso.datetime(),
      newStaffId: z.uuid().optional(),
      reason: z.string().max(200).optional(),
      override: overrideSchema.optional(),
    }),
  },
  async ({ params, body, principal }) =>
    rescheduleAppointment(
      principal!.orgId,
      { kind: "staff", principal: principal! },
      {
        appointmentId: params.id,
        newStartAt: new Date(body.newStartAt),
        newStaffId: body.newStaffId,
        reason: body.reason,
        override: body.override,
      },
    ),
);
