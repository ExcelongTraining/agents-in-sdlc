import { z } from "zod";
import { route } from "@/lib/http/route";
import { nominateReplacement } from "@/lib/services/replacement";

export const POST = route<{ nomineeStaffId: string }, { id: string }>(
  { auth: "staff", body: z.object({ nomineeStaffId: z.uuid() }) },
  async ({ params, body, principal }) => nominateReplacement(principal!, params.id, body.nomineeStaffId),
);
