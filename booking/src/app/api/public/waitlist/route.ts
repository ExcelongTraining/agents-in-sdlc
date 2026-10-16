import { route } from "@/lib/http/route";
import { joinWaitlist, waitlistSchema } from "@/lib/services/booking";

export const POST = route(
  { auth: "public", body: waitlistSchema, rate: { name: "waitlist", limit: 5, windowSeconds: 3600 } },
  async ({ body, orgId }) => joinWaitlist(orgId, body),
);
