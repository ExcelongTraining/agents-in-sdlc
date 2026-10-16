import { z } from "zod";
import { withTx, type Role } from "../db/tx";
import { AppError } from "../errors";
import { auditEvent } from "./audit";
import { checkPasswordPolicy, hashPassword, newToken, sha256, verifyPassword } from "./password";
import type { Principal } from "../domain/rbac";
import { getOrgId } from "./org";
import { rateLimit } from "./rate-limit";

export const SESSION_COOKIE = "bk_session";
const SESSION_HOURS = 12;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});

interface UserRow {
  id: string;
  organisation_id: string;
  display_name: string;
  password_hash: string | null;
  status: string;
  failed_login_count: number;
  locked_until: Date | null;
  must_change_password: boolean;
}

/** Verifies credentials, enforces lockout + rate limit, and creates a session. Returns the raw token (cookie value). */
export async function login(input: {
  email: string;
  password: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ token: string; expiresAt: Date; principal: Principal }> {
  const { email, password } = loginSchema.parse({ email: input.email, password: input.password });
  const orgId = await getOrgId();
  const generic = new AppError("UNAUTHENTICATED", "Incorrect email or password.");

  return withTx({ kind: "system", orgId, actor: "system" }, async (tx) => {
    await rateLimit(tx, `login:ip:${input.ip ?? "unknown"}`, 30, 600);
    await rateLimit(tx, `login:email:${email}`, 10, 600);

    const user = await tx.maybeOne<UserRow>("select * from auth_find_user($1)", [email]);
    const ok = await verifyPassword(password, user?.password_hash ?? null);
    if (!user || user.organisation_id !== orgId) throw generic;
    if (user.locked_until && user.locked_until > new Date()) {
      throw new AppError(
        "UNAUTHENTICATED",
        "This account is temporarily locked. Try again later or ask a manager to reset it.",
      );
    }
    if (!ok || user.status !== "active") {
      const failed = user.failed_login_count + 1;
      await tx.query(
        "update users set failed_login_count = $2, locked_until = case when $2 >= $3 then now() + make_interval(mins => $4) else locked_until end where id = $1",
        [user.id, failed, MAX_FAILED, LOCK_MINUTES],
      );
      await auditEvent(tx, { action: "auth.login_failed", entityType: "users", entityId: user.id });
      // The failure must persist even though we throw: commit by returning a marker, then throw outside the tx.
      return { failed: true as const };
    }

    const token = newToken();
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000);
    await tx.query("insert into sessions(user_id, token_hash, expires_at, user_agent) values ($1,$2,$3,$4)", [
      user.id,
      sha256(token),
      expiresAt,
      (input.userAgent ?? "").slice(0, 200),
    ]);
    await tx.query(
      "update users set failed_login_count = 0, locked_until = null, last_login_at = now() where id = $1",
      [user.id],
    );
    await tx.query("delete from sessions where user_id = $1 and expires_at < now()", [user.id]);
    await auditEvent(tx, { action: "auth.login", entityType: "users", entityId: user.id });
    const principal = await principalFromToken(tx, token);
    if (!principal) throw generic;
    return { failed: false as const, token, expiresAt, principal };
  }).then((r) => {
    if (r.failed) throw generic;
    return { token: r.token, expiresAt: r.expiresAt, principal: r.principal };
  });
}

async function principalFromToken(tx: import("../db/tx").Tx, token: string): Promise<Principal | null> {
  const row = await tx.maybeOne<{
    user_id: string;
    organisation_id: string;
    display_name: string;
    staff_id: string | null;
    roles: string[];
    must_change_password: boolean;
  }>("select * from auth_resolve_session($1)", [sha256(token)]);
  if (!row) return null;
  return {
    userId: row.user_id,
    orgId: row.organisation_id,
    staffId: row.staff_id,
    roles: row.roles as Role[],
    displayName: row.display_name,
    mustChangePassword: row.must_change_password,
  };
}

export async function resolveSessionToken(token: string | undefined | null): Promise<Principal | null> {
  if (!token || token.length < 20) return null;
  const orgId = await getOrgId();
  const p = await withTx({ kind: "system", orgId }, (tx) => principalFromToken(tx, token));
  return p && p.orgId === orgId ? p : null;
}

export async function logout(token: string | undefined): Promise<void> {
  if (!token) return;
  const orgId = await getOrgId();
  await withTx({ kind: "system", orgId }, async (tx) => {
    await tx.query("delete from sessions where token_hash = $1", [sha256(token)]);
  });
}

/** Manager-initiated password set/reset. Revokes existing sessions and forces change on next login. */
export async function setUserPassword(
  orgId: string,
  actingUserId: string,
  targetUserId: string,
  newPassword: string,
  mustChange: boolean,
): Promise<void> {
  const user = await withTx({ kind: "system", orgId, userId: actingUserId, actor: "user" }, (tx) =>
    tx.maybeOne<{ email: string }>("select email from users where id = $1", [targetUserId]),
  );
  if (!user) throw new AppError("NOT_FOUND", "User not found.");
  const problem = checkPasswordPolicy(newPassword, user.email);
  if (problem) throw new AppError("VALIDATION", problem);
  const hash = await hashPassword(newPassword);
  await withTx({ kind: "system", orgId, userId: actingUserId, actor: "user" }, async (tx) => {
    await tx.query(
      "update users set password_hash = $2, must_change_password = $3, failed_login_count = 0, locked_until = null where id = $1",
      [targetUserId, hash, mustChange],
    );
    await tx.query("delete from sessions where user_id = $1", [targetUserId]);
    await auditEvent(tx, { action: "auth.password_set", entityType: "users", entityId: targetUserId });
  });
}

/** Self-service password change. Verifies the current password, applies the policy, and signs out every other session. */
export async function changeOwnPassword(
  principal: Principal,
  current: string,
  next: string,
  keepToken?: string,
): Promise<void> {
  await withTx(
    { kind: "system", orgId: principal.orgId, userId: principal.userId, actor: "user" },
    async (tx) => {
      await rateLimit(tx, `pwchange:${principal.userId}`, 10, 900);
      const u = await tx.one<{ email: string; password_hash: string | null }>(
        "select email, password_hash from auth_find_user((select email from users where id = $1))",
        [principal.userId],
      );
      if (!(await verifyPassword(current, u.password_hash)))
        throw new AppError("UNAUTHENTICATED", "Your current password is not correct.");
      const problem = checkPasswordPolicy(next, u.email);
      if (problem) throw new AppError("VALIDATION", problem);
      if (next === current) throw new AppError("VALIDATION", "Choose a new password.");
      await tx.query("update users set password_hash = $2, must_change_password = false where id = $1", [
        principal.userId,
        await hashPassword(next),
      ]);
      await tx.query("delete from sessions where user_id = $1 and token_hash <> $2", [
        principal.userId,
        keepToken ? sha256(keepToken) : "",
      ]);
      await auditEvent(tx, {
        action: "auth.password_changed",
        entityType: "users",
        entityId: principal.userId,
      });
    },
  );
}
