import type { Tx } from "../db/tx";

export type NotificationPurpose =
  | "booking_request_received"
  | "slot_held"
  | "booking_confirmed"
  | "booking_changed"
  | "booking_cancelled"
  | "appointment_reminder"
  | "assignment_new"
  | "assignment_removed"
  | "replacement_requested"
  | "replacement_nominee_request"
  | "replacement_accepted"
  | "replacement_rejected"
  | "manager_approval_required"
  | "kpi_reminder"
  | "customer_otp"
  | "waitlist_available";

export interface EnqueueInput {
  purpose: NotificationPurpose;
  recipientKind: "customer" | "staff";
  recipientId: string;
  params?: Record<string, string | number>;
  appointmentId?: string | null;
  /** Same key => at most one job. Include the entity version/time where re-sending is legitimate. */
  dedupeKey: string;
  sendAt?: Date;
}

/**
 * Transactional outbox: the job is written in the SAME transaction as the business change, so a booking is never
 * confirmed without its notification being queued, and a rolled-back booking never notifies anyone.
 */
export async function enqueueNotification(tx: Tx, n: EnqueueInput): Promise<void> {
  await tx.query(
    `insert into notification_jobs(organisation_id, purpose, recipient_kind, recipient_id, params, appointment_id, dedupe_key, next_attempt_at)
     values ($1,$2,$3,$4,$5,$6,$7,coalesce($8, now()))
     on conflict (organisation_id, dedupe_key) do nothing`,
    [tx.ctx.orgId, n.purpose, n.recipientKind, n.recipientId, JSON.stringify(n.params ?? {}), n.appointmentId ?? null, n.dedupeKey, n.sendAt ?? null],
  );
}
