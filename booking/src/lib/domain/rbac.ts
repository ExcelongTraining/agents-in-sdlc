import type { Role } from "../db/tx";
import { AppError } from "../errors";

export type Permission =
  | "schedule.read.all"
  | "schedule.read.own"
  | "appointment.create.any"
  | "appointment.create.self"
  | "appointment.assign"
  | "appointment.transition.any"
  | "appointment.transition.own"
  | "appointment.override"
  | "availability.manage.all"
  | "availability.request.own"
  | "availability.approve"
  | "replacement.request"
  | "replacement.respond"
  | "replacement.approve"
  | "services.manage"
  | "settings.manage"
  | "users.manage"
  | "customers.read"
  | "kpi.read.all"
  | "kpi.read.own"
  | "kpi.configure"
  | "audit.read"
  | "integrations.manage"
  | "privacy.manage";

const MATRIX: Record<Exclude<Role, "customer">, readonly Permission[]> = {
  masseuse: [
    "schedule.read.own",
    "appointment.create.self",
    "appointment.transition.own",
    "availability.request.own",
    "replacement.request",
    "replacement.respond",
    "kpi.read.own",
  ],
  manager: [
    "schedule.read.all",
    "schedule.read.own",
    "appointment.create.any",
    "appointment.assign",
    "appointment.transition.any",
    "appointment.override",
    "availability.manage.all",
    "availability.approve",
    "replacement.approve",
    "services.manage",
    "settings.manage",
    "users.manage",
    "customers.read",
    "kpi.read.all",
    "kpi.configure",
    "audit.read",
    "privacy.manage",
  ],
  // Administrators run the platform. They deliberately have no schedule, customer or KPI access.
  administrator: ["audit.read", "integrations.manage", "settings.manage"],
};

export interface Principal {
  userId: string;
  orgId: string;
  staffId: string | null;
  roles: Role[];
  displayName: string;
}

export const can = (p: Principal, perm: Permission): boolean => p.roles.some((r) => r !== "customer" && MATRIX[r].includes(perm));

export function requirePermission(p: Principal | null, perm: Permission): asserts p is Principal {
  if (!p) throw new AppError("UNAUTHENTICATED", "Please sign in.");
  if (!can(p, perm)) throw new AppError("FORBIDDEN", "You do not have permission to do that.", { internal: `missing ${perm}` });
}

export const permissionsFor = (role: Exclude<Role, "customer">): readonly Permission[] => MATRIX[role];
