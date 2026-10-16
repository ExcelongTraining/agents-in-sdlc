import { cookies } from "next/headers";
import { env } from "../config/env";
import type { Principal } from "../domain/rbac";
import { resolveSessionToken, SESSION_COOKIE } from "../services/auth";

/** Current principal from the request cookie (server components, route handlers, server actions). */
export async function currentPrincipal(): Promise<Principal | null> {
  const jar = await cookies();
  return resolveSessionToken(jar.get(SESSION_COOKIE)?.value);
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true, secure: env().NODE_ENV === "production", sameSite: "lax", path: "/", expires: expiresAt,
  });
}
export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

