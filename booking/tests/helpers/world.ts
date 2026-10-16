import { Client } from "pg";
import { inject } from "vitest";
import { seedBase, type World } from "@/lib/seed/base";
import { hashPassword } from "@/lib/services/password";
import { clearOrgCacheForTests } from "@/lib/services/org";
import { closePool } from "@/lib/db/pool";
import { resetEnvCacheForTests } from "@/lib/config/env";
import type { Principal } from "@/lib/domain/rbac";
import type { Clock } from "@/lib/services/booking-shared";

let cachedHash: string | undefined;

/** Admin connection (database owner: bypasses RLS) for fixtures and assertions. */
export async function adminClient(): Promise<Client> {
  const c = new Client({ connectionString: inject("dbUrl") });
  await c.connect();
  return c;
}

/** Wipe all data and re-seed the demo world (fast: TRUNCATE ... CASCADE). */
export async function resetWorld(): Promise<World> {
  resetEnvCacheForTests();
  clearOrgCacheForTests();
  const c = await adminClient();
  try {
    const { rows } = await c.query("select tablename from pg_tables where schemaname = 'public' and tablename not in ('roles','appointment_status_transitions','schema_migrations')");
    await c.query(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`);
    cachedHash ??= await hashPassword("Demo-Password-2026!");
    return await seedBase(c, { passwordHash: cachedHash });
  } finally {
    await c.end();
  }
}

export async function shutdown(): Promise<void> {
  await closePool();
}

export const managerPrincipal = (w: World): Principal => ({ userId: w.manager.userId, orgId: w.orgId, staffId: null, roles: ["manager"], displayName: "Demo Manager" });
export const adminPrincipal = (w: World): Principal => ({ userId: w.admin.userId, orgId: w.orgId, staffId: null, roles: ["administrator"], displayName: "Demo Administrator" });
export const staffPrincipal = (w: World, i: number): Principal => {
  const s = w.staff[i]!;
  return { userId: s.userId, orgId: w.orgId, staffId: s.id, roles: ["masseuse"], displayName: s.name };
};

/** Fixed clock: Monday 4 March 2030, 10:00 Kuala Lumpur (02:00 UTC). */
export const NOW = new Date("2030-03-04T02:00:00Z");
export const clockAt = (d: Date = NOW): Clock => ({ now: () => d });
/** Local KL time on a given ISO date -> UTC Date. e.g. at("2030-03-11", "14:00"). */
export const at = (date: string, time: string): Date => new Date(`${date}T${time}:00+08:00`);
