import { z } from "zod";
import { route } from "@/lib/http/route";
import { cancelAppointment } from "@/lib/services/booking";

export const POST = route<{ reason?: string }, { id: string }>(
  { auth: "staff", body: z.object({ reason: z.string().max(200).optional() }) },
  async ({ params, body, principal }) =>
    cancelAppointment(principal!.orgId, { kind: "staff", principal: principal! }, params.id, body),
);
