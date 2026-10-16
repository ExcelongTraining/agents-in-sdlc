import { z } from "zod";
import { cookies } from "next/headers";
import { route } from "@/lib/http/route";
import { verifyOtp } from "@/lib/services/customer-access";
import { env } from "@/lib/config/env";
import { CUSTOMER_COOKIE } from "@/lib/http/customer";

export const POST = route(
  { auth: "public", body: z.object({ phone: z.string().max(30), code: z.string().length(6) }) },
  async ({ body, orgId, ip }) => {
    const { token, expiresAt } = await verifyOtp(orgId, body.phone, body.code, ip);
    (await cookies()).set(CUSTOMER_COOKIE, token, {
      httpOnly: true,
      secure: env().NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: expiresAt,
    });
    return { ok: true };
  },
);
