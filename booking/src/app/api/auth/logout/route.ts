import { cookies } from "next/headers";
import { route } from "@/lib/http/route";
import { logout, SESSION_COOKIE } from "@/lib/services/auth";
import { clearSessionCookie } from "@/lib/http/session";

export const POST = route({ auth: "public" }, async () => {
  await logout((await cookies()).get(SESSION_COOKIE)?.value);
  await clearSessionCookie();
  return { ok: true };
});
