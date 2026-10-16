import { z } from "zod";
import { route } from "@/lib/http/route";
import { listRooms, saveRoom } from "@/lib/services/admin";

export const GET = route({ auth: "staff", permission: "services.manage" }, async ({ principal }) => ({
  items: await listRooms(principal!),
}));
export const POST = route(
  {
    auth: "staff",
    permission: "services.manage",
    body: z.object({ id: z.uuid().optional(), name: z.string().max(60), active: z.boolean().default(true) }),
  },
  async ({ body, principal }) => {
    await saveRoom(principal!, body);
    return { ok: true };
  },
);
