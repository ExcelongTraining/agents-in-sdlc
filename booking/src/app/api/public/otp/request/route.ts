import { z } from "zod";
import { route } from "@/lib/http/route";
import { requestOtp } from "@/lib/services/customer-access";

/** Always answers the same way so it cannot be used to find out who is a customer. */
export const POST = route(
  { auth: "public", body: z.object({ phone: z.string().max(30) }) },
  async ({ body, orgId, ip }) => {
    await requestOtp(orgId, body.phone, ip);
    return { ok: true, message: "If that number has a booking with us, a code has been sent on WhatsApp." };
  },
);
