import { z } from "zod";
import { route } from "@/lib/http/route";
import { login } from "@/lib/services/auth";
import { setSessionCookie } from "@/lib/http/session";

export const POST = route(
  { auth: "public", body: z.object({ email: z.string().max(254), password: z.string().max(128) }) },
  async ({ body, ip, req }) => {
    const { token, expiresAt, principal } = await login({
      ...body,
      ip,
      userAgent: req.headers.get("user-agent") ?? undefined,
    });
    await setSessionCookie(token, expiresAt);
    return { user: { displayName: principal.displayName, roles: principal.roles } };
  },
);
