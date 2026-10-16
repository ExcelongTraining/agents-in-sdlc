import { z } from "zod";
import { route } from "@/lib/http/route";
import { cancelException, decideException } from "@/lib/services/availability-admin";

export const POST = route<{ approve: boolean }, { id: string }>(
  { auth: "staff", body: z.object({ approve: z.boolean() }) },
  async ({ params, body, principal }) => decideException(principal!, params.id, body.approve),
);
export const DELETE = route<undefined, { id: string }>({ auth: "staff" }, async ({ params, principal }) => {
  await cancelException(principal!, params.id);
  return { ok: true };
});
