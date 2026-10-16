import { route } from "@/lib/http/route";
import { confirmHold, confirmInputSchema } from "@/lib/services/booking";

export const POST = route(
  { auth: "public", body: confirmInputSchema, rate: { name: "confirm", limit: 15, windowSeconds: 600 } },
  async ({ body, orgId }) => confirmHold(orgId, body),
);
