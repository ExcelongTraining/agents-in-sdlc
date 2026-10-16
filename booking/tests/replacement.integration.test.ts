import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  adminClient,
  at,
  clockAt,
  managerPrincipal,
  NOW,
  resetWorld,
  shutdown,
  staffPrincipal,
} from "./helpers/world";
import { cancelAppointment, createDirectBooking, transitionAppointment } from "@/lib/services/booking";
import {
  cancelReplacement,
  decideAsManager,
  expireReplacementRequests,
  nominateReplacement,
  requestReplacement,
  respondAsNominee,
} from "@/lib/services/replacement";
import { AppError } from "@/lib/errors";
import type { World } from "@/lib/seed/base";
import { loadWorkRecords } from "@/lib/services/kpi";
import { withTx } from "@/lib/db/tx";
import { listMyReplacements } from "@/lib/services/schedule";
import { computeMetric } from "@/lib/domain/kpi";

let w: World;
const clock = clockAt(NOW);
const DAY = "2030-03-11";
let seq = 0;

beforeEach(async () => {
  w = await resetWorld();
});
afterAll(shutdown);

async function book(staffIdx = 0, start = "11:00", serviceId?: string) {
  seq++;
  return createDirectBooking(
    managerPrincipal(w),
    {
      branchId: w.branchId,
      serviceId: serviceId ?? w.services.massage60,
      startAt: at(DAY, start),
      staffId: w.staff[staffIdx]!.id,
      source: "manager",
      customer: { name: `Customer ${seq}`, phone: `01001${String(seq).padStart(5, "0")}` },
      consent: { serviceBooking: true, whatsapp: true, marketing: false },
      noticeVersion: "2026-01",
    } as never,
    clock,
  );
}
const code = async (p: Promise<unknown>): Promise<string> =>
  await p.then(
    () => "OK",
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  );
async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await adminClient();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}
const activeStaff = async (apptId: string) =>
  (
    await q<{ staff_id: string }>(
      "select staff_id from appointment_assignments where appointment_id = $1 and status = 'active'",
      [apptId],
    )
  )[0]?.staff_id;

describe("replacement workflow", () => {
  it("full path: request -> nominee accepts -> manager approves -> assignment changes, history kept", async () => {
    const b = await book(0);
    const aisyah = staffPrincipal(w, 0),
      mei = staffPrincipal(w, 1),
      mgr = managerPrincipal(w);
    const req = await requestReplacement(
      aisyah,
      { appointmentId: b.appointmentId, reason: "Family emergency", nomineeStaffId: w.staff[1]!.id },
      clock,
    );
    expect(req.status).toBe("awaiting_nominee");

    // While pending, the ORIGINAL assignment stays authoritative and the appointment is flagged.
    expect(await activeStaff(b.appointmentId)).toBe(w.staff[0]!.id);
    expect(
      (await q<{ status: string }>("select status from appointments where id = $1", [b.appointmentId]))[0]!
        .status,
    ).toBe("replacement_pending");

    expect((await respondAsNominee(mei, req.id, true)).status).toBe("awaiting_manager_approval");
    expect(await activeStaff(b.appointmentId)).toBe(w.staff[0]!.id); // still unchanged until the manager approves

    expect((await decideAsManager(mgr, req.id, true, "ok")).status).toBe("completed");
    expect(await activeStaff(b.appointmentId)).toBe(w.staff[1]!.id);
    expect(
      (await q<{ status: string }>("select status from appointments where id = $1", [b.appointmentId]))[0]!
        .status,
    ).toBe("confirmed");

    const all = await q<{ staff_id: string; status: string; origin: string }>(
      "select staff_id, status, origin from appointment_assignments where appointment_id = $1 order by assigned_at, id",
      [b.appointmentId],
    );
    expect(all).toEqual([
      { staff_id: w.staff[0]!.id, status: "superseded", origin: "booking" },
      { staff_id: w.staff[1]!.id, status: "active", origin: "replacement" },
    ]);
    const responses = await q<{ decision: string }>(
      "select decision from replacement_responses order by created_at, id",
    );
    expect(responses.map((r) => r.decision)).toEqual(["nominate", "accept", "approve"]);
    const jobs = (await q<{ purpose: string }>("select purpose from notification_jobs")).map(
      (j) => j.purpose,
    );
    expect(jobs).toEqual(
      expect.arrayContaining([
        "replacement_requested",
        "replacement_nominee_request",
        "manager_approval_required",
        "replacement_accepted",
        "booking_changed",
      ]),
    );
  });

  it("KPI hours are credited once, to the replacement only", async () => {
    const b = await book(0);
    const req = await requestReplacement(
      staffPrincipal(w, 0),
      { appointmentId: b.appointmentId, reason: "Unwell", nomineeStaffId: w.staff[1]!.id },
      clock,
    );
    await respondAsNominee(staffPrincipal(w, 1), req.id, true);
    await decideAsManager(managerPrincipal(w), req.id, true);
    const after = clockAt(at("2030-03-12", "00:00"));
    await transitionAppointment(w.orgId, staffPrincipal(w, 1), b.appointmentId, "completed", {}, after);
    const recs = await withTx({ kind: "system", orgId: w.orgId }, (tx) =>
      loadWorkRecords(tx, at(DAY, "00:00"), at("2030-03-12", "00:00")),
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]!.staffId).toBe(w.staff[1]!.id);
    const mei = computeMetric("replacement_hours", {
      records: recs.filter((r) => r.staffId === w.staff[1]!.id),
      basis: "scheduled",
    });
    const aisyah = computeMetric("completed_service_hours", {
      records: recs.filter((r) => r.staffId === w.staff[0]!.id),
      basis: "scheduled",
    });
    expect(mei.value).toBe(1);
    expect(aisyah.value).toBe(0);
  });

  it("the nominee and requester can see the request (service + time) without access to the appointment or customer", async () => {
    const b = await book(0);
    await requestReplacement(
      staffPrincipal(w, 0),
      { appointmentId: b.appointmentId, reason: "Unwell", nomineeStaffId: w.staff[1]!.id },
      clock,
    );
    const incoming = await listMyReplacements(staffPrincipal(w, 1));
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({ direction: "incoming", service: "Traditional Massage (60 min)" });
    expect((await listMyReplacements(staffPrincipal(w, 0)))[0]).toMatchObject({ direction: "outgoing" });
    expect(await listMyReplacements(staffPrincipal(w, 2))).toHaveLength(0); // uninvolved colleague sees nothing
    const direct = await withTx(
      {
        kind: "staff",
        orgId: w.orgId,
        userId: w.staff[1]!.userId,
        staffId: w.staff[1]!.id,
        roles: ["masseuse"],
      },
      (tx) => tx.query("select id from appointments"),
    );
    expect(direct).toHaveLength(0); // still no access to the appointment itself
  });

  it("an unqualified nominee is refused", async () => {
    const b = await book(0, "11:00", w.services.room60);
    expect(
      await code(
        requestReplacement(
          staffPrincipal(w, 0),
          { appointmentId: b.appointmentId, reason: "Unwell", nomineeStaffId: w.staff[2]!.id },
          clock,
        ),
      ),
    ).toBe("NOT_QUALIFIED");
    expect(
      (await q<{ status: string }>("select status from appointments where id = $1", [b.appointmentId]))[0]!
        .status,
    ).toBe("confirmed"); // nothing changed
  });

  it("a nominee who is busy is refused at request time", async () => {
    const b = await book(0, "11:00");
    await book(1, "11:00");
    expect(
      await code(
        requestReplacement(
          staffPrincipal(w, 0),
          { appointmentId: b.appointmentId, reason: "Unwell", nomineeStaffId: w.staff[1]!.id },
          clock,
        ),
      ),
    ).toBe("SLOT_TAKEN");
  });

  it("acceptance fails if the nominee became unavailable after the request", async () => {
    const b = await book(0, "11:00");
    const req = await requestReplacement(
      staffPrincipal(w, 0),
      { appointmentId: b.appointmentId, reason: "Unwell", nomineeStaffId: w.staff[1]!.id },
      clock,
    );
    await book(1, "11:00"); // nominee gets another booking meanwhile
    expect(await code(respondAsNominee(staffPrincipal(w, 1), req.id, true))).toBe("SLOT_TAKEN");
    expect(await activeStaff(b.appointmentId)).toBe(w.staff[0]!.id);
    expect(
      (await q<{ status: string }>("select status from replacement_requests where id = $1", [req.id]))[0]!
        .status,
    ).toBe("awaiting_nominee");
  });

  it("manager approval fails safely if the nominee became unavailable after accepting", async () => {
    const b = await book(0, "11:00");
    const req = await requestReplacement(
      staffPrincipal(w, 0),
      { appointmentId: b.appointmentId, reason: "Unwell", nomineeStaffId: w.staff[1]!.id },
      clock,
    );
    await respondAsNominee(staffPrincipal(w, 1), req.id, true);
    await q(
      "insert into availability_exceptions(organisation_id, branch_id, staff_id, kind, period) values ($1,$2,$3,'leave', tstzrange($4,$5,'[)'))",
      [w.orgId, w.branchId, w.staff[1]!.id, at(DAY, "10:00"), at(DAY, "19:00")],
    );
    expect((await decideAsManager(managerPrincipal(w), req.id, true)).status).toBe("failed");
    expect(await activeStaff(b.appointmentId)).toBe(w.staff[0]!.id); // original assignment preserved
    expect(
      (await q<{ status: string }>("select status from appointments where id = $1", [b.appointmentId]))[0]!
        .status,
    ).toBe("confirmed");
  });

  it("no self-approval: a manager who is also the requester cannot approve", async () => {
    const b = await book(0, "11:00");
    const req = await requestReplacement(
      staffPrincipal(w, 0),
      { appointmentId: b.appointmentId, reason: "Unwell", nomineeStaffId: w.staff[1]!.id },
      clock,
    );
    await respondAsNominee(staffPrincipal(w, 1), req.id, true);
    const dual = { ...staffPrincipal(w, 0), roles: ["masseuse", "manager"] as ("masseuse" | "manager")[] };
    expect(await code(decideAsManager(dual, req.id, true))).toBe("FORBIDDEN");
    const dualNominee = {
      ...staffPrincipal(w, 1),
      roles: ["masseuse", "manager"] as ("masseuse" | "manager")[],
    };
    expect(await code(decideAsManager(dualNominee, req.id, true))).toBe("FORBIDDEN");
    expect(await code(decideAsManager(staffPrincipal(w, 2), req.id, true))).toBe("FORBIDDEN"); // plain masseuse
    expect(await code(decideAsManager(managerPrincipal(w), req.id, true))).toBe("OK");
  });

  it("without manager approval configured the swap commits when the nominee accepts", async () => {
    await q(
      'insert into application_settings(organisation_id, key, value) values ($1,\'replacement\',\'{"requireManagerApproval":false,"notifyCustomer":false,"requestExpiryHours":24}\')',
      [w.orgId],
    );
    const b = await book(0, "11:00");
    const req = await requestReplacement(
      staffPrincipal(w, 0),
      { appointmentId: b.appointmentId, reason: "Unwell", nomineeStaffId: w.staff[1]!.id },
      clock,
    );
    expect((await respondAsNominee(staffPrincipal(w, 1), req.id, true)).status).toBe("completed");
    expect(await activeStaff(b.appointmentId)).toBe(w.staff[1]!.id);
    expect((await q("select 1 from notification_jobs where purpose = 'booking_changed'")).length).toBe(0); // customer not notified by config
  });

  it("decline restores the appointment; manager can nominate when none was given", async () => {
    const b = await book(0, "11:00");
    const req = await requestReplacement(
      staffPrincipal(w, 0),
      { appointmentId: b.appointmentId, reason: "Unwell" },
      clock,
    );
    expect(req.status).toBe("awaiting_nomination");
    await nominateReplacement(managerPrincipal(w), req.id, w.staff[2]!.id);
    expect((await respondAsNominee(staffPrincipal(w, 2), req.id, false, "Sorry")).status).toBe("declined");
    expect(
      (await q<{ status: string }>("select status from appointments where id = $1", [b.appointmentId]))[0]!
        .status,
    ).toBe("confirmed");
    // a new request can be made after a decline
    const again = await requestReplacement(
      staffPrincipal(w, 0),
      { appointmentId: b.appointmentId, reason: "Still unwell", nomineeStaffId: w.staff[3]!.id },
      clock,
    );
    expect(again.status).toBe("awaiting_nominee");
  });

  it("other masseuses cannot see, request, answer or cancel someone else's replacement", async () => {
    const b = await book(0, "11:00");
    expect(
      await code(
        requestReplacement(
          staffPrincipal(w, 2),
          { appointmentId: b.appointmentId, reason: "I am nosy" },
          clock,
        ),
      ),
    ).toBe("NOT_FOUND");
    const req = await requestReplacement(
      staffPrincipal(w, 0),
      { appointmentId: b.appointmentId, reason: "Unwell", nomineeStaffId: w.staff[1]!.id },
      clock,
    );
    expect(await code(respondAsNominee(staffPrincipal(w, 2), req.id, true))).toBe("NOT_FOUND");
    expect(await code(cancelReplacement(staffPrincipal(w, 2), req.id))).toBe("NOT_FOUND");
    expect(await code(cancelReplacement(staffPrincipal(w, 0), req.id))).toBe("OK");
  });

  it("only one open request per appointment; customer cancellation closes the request; expiry restores the appointment", async () => {
    const b = await book(0, "11:00");
    const req = await requestReplacement(
      staffPrincipal(w, 0),
      { appointmentId: b.appointmentId, reason: "Unwell", nomineeStaffId: w.staff[1]!.id },
      clock,
    );
    expect(
      await code(
        requestReplacement(staffPrincipal(w, 0), { appointmentId: b.appointmentId, reason: "again" }, clock),
      ),
    ).toBe("INVALID_TRANSITION");
    const later = clockAt(new Date(NOW.getTime() + 25 * 3600_000));
    expect(await expireReplacementRequests(w.orgId, later)).toBe(1);
    expect(
      (await q<{ status: string }>("select status from appointments where id = $1", [b.appointmentId]))[0]!
        .status,
    ).toBe("confirmed");

    const req2 = await requestReplacement(
      staffPrincipal(w, 0),
      { appointmentId: b.appointmentId, reason: "Unwell again", nomineeStaffId: w.staff[1]!.id },
      clock,
    );
    await cancelAppointment(
      w.orgId,
      { kind: "staff", principal: managerPrincipal(w) },
      b.appointmentId,
      { reason: "customer cancelled" },
      clock,
    );
    expect(
      (await q<{ status: string }>("select status from replacement_requests where id = $1", [req2.id]))[0]!
        .status,
    ).toBe("cancelled");
    void req;
  });
});
