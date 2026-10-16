import type { PoolClient, QueryResultRow } from "pg";
import { randomUUID } from "node:crypto";
import { getPool } from "./pool";
import { isRetryableDbError, mapDbError } from "./errors";

export type Role = "customer" | "masseuse" | "manager" | "administrator";
export type ActorKind = "user" | "system" | "customer" | "whatsapp" | "job";

/**
 * Who a transaction runs as.
 *  - staff : RLS-enforced as a logged-in staff member (SET LOCAL ROLE booking_staff).
 *  - system: trusted server code after its own authorisation (SET LOCAL ROLE booking_system); tenant-scoped.
 */
export type DbContext =
  | {
      kind: "staff";
      orgId: string;
      userId: string;
      staffId?: string | null;
      roles: Role[];
      requestId?: string;
    }
  | { kind: "system"; orgId: string; actor?: ActorKind; userId?: string | null; requestId?: string };

export interface Tx {
  readonly ctx: DbContext;
  query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<R[]>;
  one<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<R>;
  maybeOne<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<R | null>;
  /** Run `fn` inside a savepoint; on error the savepoint is rolled back and the error rethrown (transaction stays usable). */
  savepoint<T>(fn: () => Promise<T>): Promise<T>;
  /** Text recorded in appointment_status_history for status changes made next. */
  setStatusReason(reason: string | null): Promise<void>;
  /** Text recorded in audit_logs.reason for changes made next (e.g. manager override reason). */
  setAuditReason(reason: string | null): Promise<void>;
}

class TxImpl implements Tx {
  private sp = 0;
  constructor(
    private readonly client: PoolClient,
    readonly ctx: DbContext,
  ) {}

  async query<R extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<R[]> {
    try {
      return (await this.client.query<R>(sql, params)).rows;
    } catch (e) {
      throw mapDbError(e);
    }
  }
  async one<R extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<R> {
    const rows = await this.query<R>(sql, params);
    if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
    return rows[0] as R;
  }
  async maybeOne<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<R | null> {
    const rows = await this.query<R>(sql, params);
    return rows[0] ?? null;
  }
  async savepoint<T>(fn: () => Promise<T>): Promise<T> {
    const name = `sp_${++this.sp}`;
    await this.client.query(`savepoint ${name}`);
    try {
      const result = await fn();
      await this.client.query(`release savepoint ${name}`);
      return result;
    } catch (e) {
      await this.client.query(`rollback to savepoint ${name}`);
      throw e;
    }
  }
  async setStatusReason(reason: string | null): Promise<void> {
    await this.client.query("select set_config('app.status_reason', $1, true)", [reason ?? ""]);
  }
  async setAuditReason(reason: string | null): Promise<void> {
    await this.client.query("select set_config('app.audit_reason', $1, true)", [reason ?? ""]);
  }
}

async function applyContext(client: PoolClient, ctx: DbContext): Promise<void> {
  const role = ctx.kind === "staff" ? "booking_staff" : "booking_system";
  const userId = ctx.userId ?? "";
  const staffId = ctx.kind === "staff" ? (ctx.staffId ?? "") : "";
  const roles = ctx.kind === "staff" ? ctx.roles.join(",") : "";
  const actor = ctx.kind === "staff" ? "user" : (ctx.actor ?? "system");
  await client.query(`set local role ${role}`);
  await client.query(
    `select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('app.staff_id', $3, true),
            set_config('app.roles', $4, true), set_config('app.actor', $5, true), set_config('app.request_id', $6, true),
            set_config('app.status_reason', '', true), set_config('app.audit_reason', '', true)`,
    [ctx.orgId, userId, staffId, roles, actor, ctx.requestId ?? randomUUID()],
  );
}

/**
 * Run `fn` in one transaction (READ COMMITTED; correctness of booking rests on constraints, not isolation level).
 * Serialization failures and deadlocks are retried with the whole callback re-executed, so `fn` must be re-runnable.
 */
export async function withTx<T>(
  ctx: DbContext,
  fn: (tx: Tx) => Promise<T>,
  opts: { retries?: number } = {},
): Promise<T> {
  const maxAttempts = (opts.retries ?? 3) + 1;
  for (let attempt = 1; ; attempt++) {
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await applyContext(client, ctx);
      const result = await fn(new TxImpl(client, ctx));
      await client.query("commit");
      return result;
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      if (isRetryableDbError(e) && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 25 * 2 ** attempt + Math.random() * 25));
        continue;
      }
      throw mapDbError(e);
    } finally {
      client.release();
    }
  }
}

/** Convenience for read-only queries. */
export async function readTx<T>(ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTx(ctx, fn, { retries: 1 });
}
