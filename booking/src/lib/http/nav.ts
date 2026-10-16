import type { Principal } from "../domain/rbac";

/** Landing page per role. A user with several roles lands on the broadest one. */
export function homeFor(p: Principal): string {
  if (p.roles.includes("manager")) return "/manager";
  if (p.roles.includes("masseuse")) return "/staff";
  if (p.roles.includes("administrator")) return "/admin";
  return "/";
}
