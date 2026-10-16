import { z } from "zod";
import { withTx, type Tx } from "../db/tx";
import { AppError, isAppError } from "../errors";
import { can, requirePermission, type Principal } from "../domain/rbac";
import {
  branchTimezone, lockAppointment, notificationParams, notifyBooking, notifyStaff, systemClock, type AppointmentRow, type AssignmentRow, type Clock,
} from "./booking-shared";
import { ctxFor, swapAssignment } from "./booking";
import { enqueueNotification, notifyManagers } from "./notifications";
import { loadSettings } from "./settings";
import { auditEvent } from "./audit";

export interface ReplacementRow {
  id: string;
  appointment_id: string;
  original_assignment_id: string;
  requested_by_staff_id: string;
  nominee_staff_id: string | null;
  status: string;
  requires_manager_approval: boolean;
  expires_at: Date | null;
  reason: string;
}

const OPEN = ["awaiting_nominee", "awaiting_nomination", "awaiting_manager_approval"];
const SENTINEL = Symbol("dry-run-rollback");

/**
 * Dry run: would `staffId` be accepted for this appointment right now? Uses the REAL database rules (qualification,
 * working hours, leave, overlap) by performing the swap inside a savepoint that is always rolled back.
 */
export async function checkCanTakeOver(tx: Tx, appt: AppointmentRow, originalAssignmentId: string, staffId: string): Promise<AppError | null> {
  try {
    await tx.savepoint(async () => {
      await swapAssignment(tx, appt, originalAssignmentId, staffId, "replacement");
      throw SENTINEL;
    });
  } catch (e) {
    if (e === SENTINEL) return null;
    if (isAppError(e)) return e;
    throw e;
  }
  return null;
}

async function loadRequest(tx: Tx, id: string): Promise<ReplacementRow> {
  const r = await tx.maybeOne<ReplacementRow>("select * from replacement_requests where id = $1 and organisation_id = $2 for update", [id, tx.ctx.orgId]);
  if (!r) throw new AppError("NOT_FOUND", "Replacement request not found.");
  return r;
}

async function respond(tx: Tx, requestId: string, p: Principal, role: "requester" | "nominee" | "manager", decision: string, comment?: string): Promise<void> {
  await tx.query(
    "insert into replacement_responses(organisation_id, request_id, responder_user_id, responder_staff_id, responder_role, decision, comment) values ($1,$2,$3,$4,$5,$6,$7)",
    [tx.ctx.orgId, requestId, p.userId, p.staffId, role, decision, comment?.slice(0, 300) ?? null]);
}

async function restoreAppointment(tx: Tx, appointmentId: string, why: string): Promise<void> {
  await tx.setStatusReason(why);
  await tx.query("update appointments set status = 'confirmed' where id = $1 and status = 'replacement_pending'", [appointmentId]);
}

async function staffParams(tx: Tx, appointmentId: string): Promise<Record<string, string>> {
  const a = await tx.one<{ branch_id: string }>("select branch_id from appointments where id = $1", [appointmentId]);
  return notificationParams(tx, appointmentId, await branchTimezone(tx, a.branch_id));
}

// ---------------------------------------------------------------------------------------------
export const requestSchema = z.object({
  appointmentId: z.uuid(),
  reason: z.string().trim().min(3).max(300),
  nomineeStaffId: z.uuid().optional(),
});

export async function requestReplacement(principal: Principal, raw: z.infer<typeof requestSchema>, clock: Clock = systemClock): Promise<{ id: string; status: string }> {
  const input = requestSchema.parse(raw);
  requirePermission(principal, "replacement.request");
  return withTx(ctxFor(principal.orgId, { kind: "staff", principal }), async (tx) => {
    const { appt, assignment } = await lockAppointment(tx, input.appointmentId);
    // Only the assigned masseuse can ask to be replaced; anything else looks like "not found" to avoid leaking schedules.
    if (!assignment || !principal.staffId || assignment.staff_id !== principal.staffId) throw new AppError("NOT_FOUND", "Appointment not found.");
    if (appt.status !== "confirmed") throw new AppError("INVALID_TRANSITION", "A replacement can only be requested for a confirmed appointment.");
    const now = clock.now();
    if (appt.start_at <= now) throw new AppError("NOT_ALLOWED", "This appointment has already started.");
    if (input.nomineeStaffId === principal.staffId) throw new AppError("VALIDATION", "You cannot nominate yourself.");
    if (input.nomineeStaffId) {
      const problem = await checkCanTakeOver(tx, appt, assignment.id, input.nomineeStaffId);
      if (problem) throw problem;
    }
    const settings = await loadSettings(tx);
    const expiresAt = new Date(Math.min(appt.start_at.getTime(), now.getTime() + settings.replacement.requestExpiryHours * 3600_000));
    const status = input.nomineeStaffId ? "awaiting_nominee" : "awaiting_nomination";
    const req = await tx.one<{ id: string }>(
      `insert into replacement_requests(organisation_id, appointment_id, original_assignment_id, requested_by_staff_id, nominee_staff_id, reason, status, requires_manager_approval, expires_at, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [principal.orgId, appt.id, assignment.id, principal.staffId, input.nomineeStaffId ?? null, input.reason, status, settings.replacement.requireManagerApproval, expiresAt, principal.userId]);
    await respond(tx, req.id, principal, "requester", input.nomineeStaffId ? "nominate" : "nominate", input.reason);
    await tx.setStatusReason("replacement requested");
    await tx.query("update appointments set status = 'replacement_pending' where id = $1", [appt.id]);

    const params = await staffParams(tx, appt.id);
    if (input.nomineeStaffId) {
      await enqueueNotification(tx, { purpose: "replacement_nominee_request", recipientKind: "staff", recipientId: input.nomineeStaffId, params, appointmentId: appt.id, dedupeKey: `repl-nominee:${req.id}` });
    }
    await notifyManagers(tx, "replacement_requested", params, appt.id, `repl-requested:${req.id}`);
    return { id: req.id, status };
  });
}

/** Manager picks the nominee when the requester did not (or the nominee declined and a new one is needed). */
export async function nominateReplacement(principal: Principal, requestId: string, nomineeStaffId: string): Promise<{ status: string }> {
  requirePermission(principal, "replacement.approve");
  return withTx(ctxFor(principal.orgId, { kind: "staff", principal }), async (tx) => {
    const r = await loadRequest(tx, requestId);
    if (r.status !== "awaiting_nomination") throw new AppError("INVALID_TRANSITION", "This request is not waiting for a nominee.");
    if (nomineeStaffId === r.requested_by_staff_id) throw new AppError("VALIDATION", "Choose a different masseuse.");
    const { appt } = await lockAppointment(tx, r.appointment_id);
    const problem = await checkCanTakeOver(tx, appt, r.original_assignment_id, nomineeStaffId);
    if (problem) throw problem;
    await tx.query("update replacement_requests set nominee_staff_id = $2, status = 'awaiting_nominee', updated_by = $3 where id = $1", [r.id, nomineeStaffId, principal.userId]);
    await respond(tx, r.id, principal, "manager", "nominate");
    await enqueueNotification(tx, { purpose: "replacement_nominee_request", recipientKind: "staff", recipientId: nomineeStaffId, params: await staffParams(tx, appt.id), appointmentId: appt.id, dedupeKey: `repl-nominee:${r.id}:${nomineeStaffId}` });
    return { status: "awaiting_nominee" };
  });
}

export async function respondAsNominee(principal: Principal, requestId: string, accept: boolean, comment?: string): Promise<{ status: string }> {
  requirePermission(principal, "replacement.respond");
  return withTx(ctxFor(principal.orgId, { kind: "staff", principal }), async (tx) => {
    const r = await loadRequest(tx, requestId);
    if (!principal.staffId || r.nominee_staff_id !== principal.staffId) throw new AppError("NOT_FOUND", "Replacement request not found.");
    if (r.status !== "awaiting_nominee") throw new AppError("INVALID_TRANSITION", "This request is no longer waiting for your answer.");
    const { appt, assignment } = await lockAppointment(tx, r.appointment_id);
    const params = await staffParams(tx, appt.id);

    if (!accept) {
      await tx.query("update replacement_requests set status = 'declined', updated_by = $2 where id = $1", [r.id, principal.userId]);
      await respond(tx, r.id, principal, "nominee", "decline", comment);
      await restoreAppointment(tx, appt.id, "replacement declined by nominee");
      await enqueueNotification(tx, { purpose: "replacement_rejected", recipientKind: "staff", recipientId: r.requested_by_staff_id, params, appointmentId: appt.id, dedupeKey: `repl-declined:${r.id}` });
      return { status: "declined" };
    }

    // Accepting is refused (and nothing changes) if the nominee can no longer take the appointment.
    if (!assignment || assignment.id !== r.original_assignment_id) throw new AppError("NOT_ALLOWED", "The appointment has changed. Please ask for a new request.");
    const problem = await checkCanTakeOver(tx, appt, assignment.id, principal.staffId);
    if (problem) throw problem;
    await respond(tx, r.id, principal, "nominee", "accept", comment);
    await tx.query("update replacement_requests set nominee_accepted_at = now(), updated_by = $2 where id = $1", [r.id, principal.userId]);

    if (r.requires_manager_approval) {
      await tx.query("update replacement_requests set status = 'awaiting_manager_approval' where id = $1", [r.id]);
      await notifyManagers(tx, "manager_approval_required", params, appt.id, `repl-approval:${r.id}`);
      return { status: "awaiting_manager_approval" };
    }
    return commit(tx, r, appt, assignment, null);
  });
}

export async function decideAsManager(principal: Principal, requestId: string, approve: boolean, note?: string): Promise<{ status: string }> {
  requirePermission(principal, "replacement.approve");
  return withTx(ctxFor(principal.orgId, { kind: "staff", principal }), async (tx) => {
    const r = await loadRequest(tx, requestId);
    if (r.status !== "awaiting_manager_approval") throw new AppError("INVALID_TRANSITION", "This request is not waiting for approval.");
    // No self-approval: the approver must not be the requester or the nominee (e.g. a manager who also works as a masseuse).
    const involved = await tx.query<{ user_id: string }>("select user_id from staff_profiles where id = any($1)", [[r.requested_by_staff_id, r.nominee_staff_id].filter(Boolean)]);
    if (involved.some((s) => s.user_id === principal.userId))
      throw new AppError("FORBIDDEN", "You cannot approve a replacement you are part of. Ask another manager.");
    const { appt, assignment } = await lockAppointment(tx, r.appointment_id);
    const params = await staffParams(tx, appt.id);

    if (!approve) {
      await tx.query("update replacement_requests set status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1", [r.id, principal.userId, note?.slice(0, 300) ?? null]);
      await respond(tx, r.id, principal, "manager", "reject", note);
      await restoreAppointment(tx, appt.id, "replacement rejected by manager");
      for (const staffId of [r.requested_by_staff_id, r.nominee_staff_id].filter((x): x is string => !!x))
        await enqueueNotification(tx, { purpose: "replacement_rejected", recipientKind: "staff", recipientId: staffId, params, appointmentId: appt.id, dedupeKey: `repl-rejected:${r.id}:${staffId}` });
      return { status: "rejected" };
    }
    if (!assignment || assignment.id !== r.original_assignment_id) throw new AppError("NOT_ALLOWED", "The appointment has changed since this request was made.");
    await respond(tx, r.id, principal, "manager", "approve", note);
    return commit(tx, r, appt, assignment, principal.userId, note);
  });
}

/**
 * Commit the swap. Runs only after every required approval. Re-validates against the live database (the nominee may
 * have become unavailable since accepting); on failure the request is marked failed and the ORIGINAL assignment stays.
 */
async function commit(tx: Tx, r: ReplacementRow, appt: AppointmentRow, assignment: AssignmentRow, approverUserId: string | null, note?: string): Promise<{ status: string }> {
  const nominee = r.nominee_staff_id as string;
  const settings = await loadSettings(tx);
  try {
    const newAssignmentId = await tx.savepoint(async () => {
      await tx.setAuditReason(`replacement ${r.id}: ${r.reason}`.slice(0, 300));
      const id = await swapAssignment(tx, appt, assignment.id, nominee, "replacement", { replacementRequestId: r.id });
      await tx.setAuditReason(null);
      return id;
    });
    await tx.query(
      `update replacement_requests set status = 'completed', resulting_assignment_id = $2, decided_by = coalesce($3, decided_by),
              decided_at = case when $3::uuid is not null then now() else decided_at end, decision_note = $4 where id = $1`,
      [r.id, newAssignmentId, approverUserId, note?.slice(0, 300) ?? null]);
    await restoreAppointment(tx, appt.id, "replacement completed");
    const params = await staffParams(tx, appt.id);
    await notifyStaff(tx, "assignment_new", nominee, appt, `repl-${r.id}`);
    await notifyStaff(tx, "assignment_removed", assignment.staff_id, appt, `repl-${r.id}`);
    await enqueueNotification(tx, { purpose: "replacement_accepted", recipientKind: "staff", recipientId: r.requested_by_staff_id, params, appointmentId: appt.id, dedupeKey: `repl-accepted:${r.id}` });
    if (settings.replacement.notifyCustomer) await notifyBooking(tx, "booking_changed", appt, `repl-${r.id}`);
    await auditEvent(tx, { action: "replacement.completed", entityType: "replacement_requests", entityId: r.id, data: { from: assignment.staff_id, to: nominee } });
    return { status: "completed" };
  } catch (e) {
    if (!isAppError(e)) throw e;
    await tx.query("update replacement_requests set status = 'failed', failure_reason = $2 where id = $1", [r.id, e.code]);
    await restoreAppointment(tx, appt.id, "replacement failed");
    await enqueueNotification(tx, { purpose: "replacement_rejected", recipientKind: "staff", recipientId: r.requested_by_staff_id, params: await staffParams(tx, appt.id), appointmentId: appt.id, dedupeKey: `repl-failed:${r.id}` });
    return { status: "failed" };
  }
}

export async function cancelReplacement(principal: Principal, requestId: string): Promise<{ status: string }> {
  return withTx(ctxFor(principal.orgId, { kind: "staff", principal }), async (tx) => {
    const r = await loadRequest(tx, requestId);
    const isRequester = !!principal.staffId && r.requested_by_staff_id === principal.staffId;
    if (!isRequester && !can(principal, "replacement.approve")) throw new AppError("NOT_FOUND", "Replacement request not found.");
    if (!OPEN.includes(r.status)) throw new AppError("INVALID_TRANSITION", "This request is already closed.");
    await tx.query("update replacement_requests set status = 'cancelled' where id = $1", [r.id]);
    await respond(tx, r.id, principal, isRequester ? "requester" : "manager", "cancel");
    await restoreAppointment(tx, r.appointment_id, "replacement cancelled");
    return { status: "cancelled" };
  });
}

/** Cron: close requests that ran out of time (expired) so the appointment is unambiguous again. */
export async function expireReplacementRequests(orgId: string, clock: Clock = systemClock): Promise<number> {
  return withTx({ kind: "system", orgId, actor: "job" }, async (tx) => {
    const rows = await tx.query<{ id: string; appointment_id: string; requested_by_staff_id: string }>(
      `update replacement_requests set status = 'expired'
        where organisation_id = $1 and status in ('awaiting_nominee','awaiting_nomination','awaiting_manager_approval') and expires_at <= $2
        returning id, appointment_id, requested_by_staff_id`, [orgId, clock.now()]);
    for (const r of rows) {
      await restoreAppointment(tx, r.appointment_id, "replacement request expired");
      await enqueueNotification(tx, { purpose: "replacement_rejected", recipientKind: "staff", recipientId: r.requested_by_staff_id, params: await staffParams(tx, r.appointment_id), appointmentId: r.appointment_id, dedupeKey: `repl-expired:${r.id}` });
    }
    return rows.length;
  });
}
