import { redirect } from "next/navigation";
import type { Principal } from "../domain/rbac";
import type { Role } from "../db/tx";
import { currentPrincipal } from "./session";
import { homeFor } from "./nav";

/** Server-component guard: signed in, holds one of `roles`, and has changed an initial password. Never relies on hidden UI. */
export async function requireRole(
  roles: Role[],
  opts: { allowPasswordChange?: boolean } = {},
): Promise<Principal> {
  const p = await currentPrincipal();
  if (!p) redirect("/login");
  if (p.mustChangePassword && !opts.allowPasswordChange) redirect("/account");
  if (!p.roles.some((r) => roles.includes(r))) redirect(homeFor(p));
  return p;
}
