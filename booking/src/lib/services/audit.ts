import type { Tx } from "../db/tx";

/**
 * Row-level audit is automatic (DB triggers: audit_row). Use this for events that are not row changes:
 * logins, exports, overrides used, privacy actions, webhook rejections.
 * `data` must not contain personal data beyond opaque ids.
 */
export async function auditEvent(
  tx: Tx,
  e: {
    action: string;
    entityType: string;
    entityId?: string | null;
    data?: Record<string, unknown>;
    reason?: string | null;
  },
): Promise<void> {
  await tx.query(
    `insert into audit_logs(organisation_id, actor_user_id, actor_kind, action, entity_type, entity_id, after_data, reason, request_id)
     values ($1, nullif(current_setting('app.user_id', true), '')::uuid, coalesce(nullif(current_setting('app.actor', true), ''), 'system'),
             $2, $3, $4, $5, $6, nullif(current_setting('app.request_id', true), ''))`,
    [
      tx.ctx.orgId,
      e.action,
      e.entityType,
      e.entityId ?? null,
      e.data ? JSON.stringify(e.data) : null,
      e.reason ?? null,
    ],
  );
}
