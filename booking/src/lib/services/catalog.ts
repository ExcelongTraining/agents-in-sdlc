import { withTx } from "../db/tx";
import type { Principal } from "../domain/rbac";
import { staffCtx } from "./schedule";

/** Service / staff lists for booking forms, read under the caller's own RLS context. */
export async function bookingFormData(p: Principal) {
  return withTx(staffCtx(p), async (tx) => {
    const branch = await tx.one<{ id: string }>(
      "select id from branches where active order by created_at limit 1",
    );
    const services = await tx.query<{
      id: string;
      name: string;
      kind: string;
      durationMinutes: number;
      staffIds: string[];
    }>(
      `select s.id, s.name, s.kind, s.duration_minutes "durationMinutes", coalesce((select array_agg(staff_id) from staff_services where service_id = s.id), '{}') "staffIds"
         from services s where s.active order by s.kind desc, s.name`,
    );
    const staff = await tx.query<{ id: string; name: string }>(
      "select id, display_name name from staff_profiles where active and archived_at is null order by display_name",
    );
    return { branchId: branch.id, services, staff };
  });
}

export async function listReplacementHistory(p: Principal) {
  return withTx(staffCtx(p), (tx) =>
    tx.query<{
      id: string;
      status: string;
      start_at: Date;
      requester: string;
      nominee: string | null;
      reason: string;
      created_at: Date;
      decision_note: string | null;
      failure_reason: string | null;
    }>(
      `select r.id, r.status, r.starts_at start_at, rq.display_name requester, nm.display_name nominee, r.reason, r.created_at, r.decision_note, r.failure_reason
         from replacement_requests r join staff_profiles rq on rq.id = r.requested_by_staff_id
         left join staff_profiles nm on nm.id = r.nominee_staff_id order by r.created_at desc limit 40`,
    ),
  );
}
