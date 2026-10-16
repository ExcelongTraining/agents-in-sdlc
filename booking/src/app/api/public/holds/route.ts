import { z } from "zod";
import { route } from "@/lib/http/route";
import { createHold, releaseHold } from "@/lib/services/booking";

const body = z.object({
  branchId: z.uuid(),
  serviceId: z.uuid(),
  startAt: z.iso.datetime(),
  staffId: z.union([z.uuid(), z.literal("any")]),
  idempotencyKey: z.string().min(8).max(128),
});
export const POST = route(
  { auth: "public", body, rate: { name: "hold", limit: 20, windowSeconds: 600 } },
  async ({ body, orgId }) => createHold(orgId, { ...body, startAt: new Date(body.startAt), source: "web" }),
);

export const DELETE = route(
  { auth: "public", body: z.object({ holdToken: z.string().max(200) }) },
  async ({ body, orgId }) => {
    await releaseHold(orgId, body.holdToken);
    return { ok: true };
  },
);
