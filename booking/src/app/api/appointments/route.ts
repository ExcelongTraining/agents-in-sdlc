import { route } from "@/lib/http/route";
import { createDirectBooking, directInputSchema } from "@/lib/services/booking";

export const POST = route(
  { auth: "staff", body: directInputSchema, rate: { name: "direct", limit: 60, windowSeconds: 60 } },
  async ({ body, principal }) => createDirectBooking(principal!, body),
);
