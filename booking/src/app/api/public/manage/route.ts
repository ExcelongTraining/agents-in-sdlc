import { route } from "@/lib/http/route";
import { listCustomerBookings } from "@/lib/services/customer-access";
import { resolveCustomerAccess } from "@/lib/http/customer";

/** GET ?token=... (manage link: one booking) or no token + customer cookie from the WhatsApp code (all upcoming bookings). */
export const GET = route(
  { auth: "public", rate: { name: "manage", limit: 60, windowSeconds: 60 } },
  async ({ req, orgId }) => {
    const token = new URL(req.url).searchParams.get("token");
    const access = await resolveCustomerAccess(orgId, token);
    return { bookings: await listCustomerBookings(orgId, access) };
  },
);
