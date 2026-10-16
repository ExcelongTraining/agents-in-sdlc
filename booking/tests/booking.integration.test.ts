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
import {
  cancelAppointment,
  confirmHold,
  createDirectBooking,
  createHold,
  releaseHold,
  rescheduleAppointment,
  transitionAppointment,
  type DirectInput,
} from "@/lib/services/booking";
import { AppError } from "@/lib/errors";
import type { World } from "@/lib/seed/base";

let w: World;
const clock = clockAt(NOW);
const DAY = "2030-03-11"; // Monday

beforeEach(async () => {
  w = await resetWorld();
});
afterAll(shutdown);

let seq = 0;
const direct = (
  over: Partial<DirectInput> & { staffIdx?: number; serviceId?: string; start?: string; date?: string } = {},
): DirectInput => {
  seq++;
  return {
    branchId: w.branchId,
    serviceId: over.serviceId ?? w.services.massage60,
    startAt: over.startAt ?? at(over.date ?? DAY, over.start ?? "11:00"),
    staffId: over.staffId ?? w.staff[over.staffIdx ?? 0]!.id,
    source: "manager",
    customer: { name: `Test Customer ${seq}`, phone: `01000${String(seq).padStart(5, "0")}` },
    consent: { serviceBooking: true, whatsapp: true, marketing: false },
    noticeVersion: "2026-01",
    ...over,
  } as DirectInput;
};
const expectCode = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected ${code}`).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
};
const count = async (sql: string, params: unknown[] = []): Promise<number> => {
  const c = await adminClient();
  try {
    return Number((await c.query(sql, params)).rows[0].n);
  } finally {
    await c.end();
  }
};

describe("double-booking prevention (database-enforced)", () => {
  it("two customers racing for the same masseuse and time: exactly one succeeds", async () => {
    const mgr = managerPrincipal(w);
    for (let round = 0; round < 5; round++) {
      const start = at(DAY, `${10 + round * 2}:00`);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => createDirectBooking(mgr, direct({ startAt: start }), clock)),
      );
      const ok = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(7);
      for (const f of failed) expect((f.reason as AppError).code).toBe("SLOT_TAKEN");
    }
    expect(await count("select count(*) n from appointment_assignments where status = 'active'")).toBe(5);
  });

  it("concurrent customer holds for the same slot: exactly one hold is granted", async () => {
    const res = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        createHold(
          w.orgId,
          {
            branchId: w.branchId,
            serviceId: w.services.massage60,
            startAt: at(DAY, "14:00"),
            staffId: w.staff[1]!.id,
            source: "web",
            idempotencyKey: `race-key-${i}-xxxxxxxx`,
          },
          clock,
        ),
      ),
    );
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("'any available' under contention spreads across staff and never double-books", async () => {
    const mgr = managerPrincipal(w);
    const res = await Promise.allSettled(
      Array.from({ length: 9 }, () =>
        createDirectBooking(mgr, direct({ staffId: "any", startAt: at(DAY, "15:00") }), clock),
      ),
    );
    const ok = res.filter((r) => r.status === "fulfilled");
    // 5 staff qualify for massage60; Lakshmi (idx 4) does not work Monday => 4 available
    expect(ok).toHaveLength(4);
    const staffIds = new Set(
      ok.map((r) => (r as PromiseFulfilledResult<{ staffId: string | null }>).value.staffId),
    );
    expect(staffIds.size).toBe(4);
  });

  it("overlapping bookings with different durations conflict; touching ones (with buffer respected) do not", async () => {
    const mgr = managerPrincipal(w);
    await createDirectBooking(mgr, direct({ serviceId: w.services.deep90, start: "12:00" }), clock); // 12:00-13:30 (+10 buffer => 13:40)
    await expectCode(
      createDirectBooking(mgr, direct({ serviceId: w.services.trial30, start: "13:00" }), clock),
      "SLOT_TAKEN",
    ); // inside
    await expectCode(
      createDirectBooking(mgr, direct({ serviceId: w.services.trial30, start: "11:45" }), clock),
      "SLOT_TAKEN",
    ); // trial ends 12:15
    await expectCode(
      createDirectBooking(mgr, direct({ serviceId: w.services.massage60, start: "13:30" }), clock),
      "SLOT_TAKEN",
    ); // inside buffer
    await createDirectBooking(mgr, direct({ serviceId: w.services.massage60, start: "13:40" }), clock); // right after buffer
  });

  it("buffer time: a 60-min service with 10-min cleanup blocks the next 10 minutes", async () => {
    const mgr = managerPrincipal(w);
    await createDirectBooking(mgr, direct({ start: "10:00" }), clock); // 10:00-11:00, occupied until 11:10
    await expectCode(createDirectBooking(mgr, direct({ start: "11:00" }), clock), "SLOT_TAKEN");
    await expectCode(createDirectBooking(mgr, direct({ start: "11:05" }), clock), "SLOT_TAKEN");
    await createDirectBooking(mgr, direct({ start: "11:10" }), clock);
  });

  it("room conflict: more bookings than rooms at one time is rejected even with free staff", async () => {
    const mgr = managerPrincipal(w);
    await createDirectBooking(
      mgr,
      direct({ serviceId: w.services.room60, staffIdx: 0, start: "16:00" }),
      clock,
    );
    await createDirectBooking(
      mgr,
      direct({ serviceId: w.services.room60, staffIdx: 1, start: "16:00" }),
      clock,
    );
    await expectCode(
      createDirectBooking(mgr, direct({ serviceId: w.services.room60, staffIdx: 3, start: "16:00" }), clock),
      "ROOM_TAKEN",
    );
  });

  it("cancelled bookings free the slot", async () => {
    const mgr = managerPrincipal(w);
    const b = await createDirectBooking(mgr, direct({ start: "11:00" }), clock);
    await expectCode(createDirectBooking(mgr, direct({ start: "11:00" }), clock), "SLOT_TAKEN");
    await cancelAppointment(
      w.orgId,
      { kind: "staff", principal: mgr },
      b.appointmentId,
      { reason: "test" },
      clock,
    );
    await createDirectBooking(mgr, direct({ start: "11:00" }), clock);
  });
});

describe("rules enforced by triggers", () => {
  it("unqualified staff cannot be assigned", async () => {
    const mgr = managerPrincipal(w);
    // Priya(2) is not qualified for the private-room service
    await expectCode(
      createDirectBooking(mgr, direct({ serviceId: w.services.room60, staffIdx: 2 }), clock),
      "NOT_QUALIFIED",
    );
  });

  it("approved leave blocks bookings; a booking blocks new leave", async () => {
    const c = await adminClient();
    try {
      await c.query(
        "insert into availability_exceptions(organisation_id, branch_id, staff_id, kind, period, reason) values ($1,$2,$3,'leave', tstzrange($4,$5,'[)'), 'annual leave')",
        [w.orgId, w.branchId, w.staff[0]!.id, at(DAY, "10:00"), at(DAY, "19:00")],
      );
      const mgr = managerPrincipal(w);
      await expectCode(createDirectBooking(mgr, direct({ start: "11:00" }), clock), "STAFF_UNAVAILABLE");
      // other staff unaffected
      await createDirectBooking(mgr, direct({ staffIdx: 1, start: "11:00" }), clock);
      // leave over an existing booking is refused until it is resolved
      await expect(
        c.query(
          "insert into availability_exceptions(organisation_id, branch_id, staff_id, kind, period) values ($1,$2,$3,'leave', tstzrange($4,$5,'[)'))",
          [w.orgId, w.branchId, w.staff[1]!.id, at(DAY, "10:30"), at(DAY, "12:00")],
        ),
      ).rejects.toMatchObject({ code: "BK007" });
    } finally {
      await c.end();
    }
  });

  it("outside working hours is rejected without override, and accepted with override + reason (audited)", async () => {
    const mgr = managerPrincipal(w);
    await expectCode(createDirectBooking(mgr, direct({ start: "19:30" }), clock), "OUTSIDE_WORKING_HOURS"); // Aisyah works until 19:00
    await expect(
      createDirectBooking(
        mgr,
        direct({ start: "19:30", override: { rules: ["working_hours"], reason: "" } }),
        clock,
      ),
    ).rejects.toThrow();
    const b = await createDirectBooking(
      mgr,
      direct({
        start: "19:30",
        override: { rules: ["working_hours"], reason: "Customer requested late slot" },
      }),
      clock,
    );
    expect(b.status).toBe("confirmed");
    expect(
      await count(
        "select count(*) n from audit_logs where action = 'booking.override_used' and reason = 'Customer requested late slot'",
      ),
    ).toBe(1);
    expect(
      await count(
        "select count(*) n from appointment_assignments where override_reason = 'Customer requested late slot'",
      ),
    ).toBe(1);
  });

  it("hard rules cannot be overridden: leave and double-booking", async () => {
    const mgr = managerPrincipal(w);
    await createDirectBooking(mgr, direct({ start: "11:00" }), clock);
    await expectCode(
      createDirectBooking(
        mgr,
        direct({
          start: "11:00",
          override: { rules: ["working_hours", "business_hours", "break"], reason: "please just do it" },
        }),
        clock,
      ),
      "SLOT_TAKEN",
    );
  });

  it("a masseuse cannot use overrides", async () => {
    await expectCode(
      createDirectBooking(
        staffPrincipal(w, 0),
        direct({
          source: "staff_direct",
          start: "19:30",
          override: { rules: ["working_hours"], reason: "I want to" },
        }),
        clock,
      ),
      "FORBIDDEN",
    );
  });

  it("time-zone boundaries: weekday and hours are evaluated in Asia/Kuala_Lumpur, not UTC", async () => {
    const mgr = managerPrincipal(w);
    // Sunday 11:00 KL = Sunday 03:00 UTC. Aisyah does not work Sundays.
    await expectCode(
      createDirectBooking(mgr, direct({ date: "2030-03-10", start: "11:00" }), clock),
      "OUTSIDE_WORKING_HOURS",
    );
    // Lakshmi works Sunday 13:00-21:00 KL. 13:00 KL = 05:00 UTC: allowed.
    await createDirectBooking(mgr, direct({ date: "2030-03-10", start: "13:00", staffIdx: 4 }), clock);
    // Saturday 23:30 KL is 15:30 UTC (same UTC day) but is after close; Monday 00:30 KL is Sunday 16:30 UTC.
    await expectCode(
      createDirectBooking(mgr, direct({ date: "2030-03-09", start: "20:30", staffIdx: 4 }), clock),
      "OUTSIDE_WORKING_HOURS",
    ); // Lakshmi off Saturday? works Tue-Sun => Sat ok, 20:30+60 > 21:00 => outside
    // A booking that crosses midnight is never inside working hours
    await expectCode(
      createDirectBooking(
        mgr,
        direct({ date: "2030-03-09", start: "23:30", serviceId: w.services.massage60, staffIdx: 4 }),
        clock,
      ),
      "OUTSIDE_WORKING_HOURS",
    );
  });
});

describe("customer hold -> confirm flow", () => {
  const holdIn = (key: string, over: Record<string, unknown> = {}) => ({
    branchId: w.branchId,
    serviceId: w.services.massage60,
    startAt: at(DAY, "13:00"),
    staffId: w.staff[2]!.id,
    source: "web" as const,
    idempotencyKey: key,
    ...over,
  });
  const confirmIn = (token: string, key: string, phone = "0123456789") => ({
    holdToken: token,
    customer: { name: "Alice Test", phone },
    consent: { serviceBooking: true as const, whatsapp: true, marketing: false },
    noticeVersion: "2026-01",
    idempotencyKey: key,
  });

  it("holds, confirms, queues WhatsApp notifications for customer and masseuse", async () => {
    const hold = await createHold(w.orgId, holdIn("hold-key-001"), clock);
    expect(new Date(hold.expiresAt).getTime() - NOW.getTime()).toBe(10 * 60_000);
    const booking = await confirmHold(w.orgId, confirmIn(hold.holdToken, "confirm-key-001"), clock);
    expect(booking.status).toBe("confirmed");
    expect(booking.staffName).toBe("Priya");
    expect(booking.manageToken).toContain(booking.appointmentId);
    const c = await adminClient();
    try {
      const jobs = (await c.query("select purpose, recipient_kind from notification_jobs order by purpose"))
        .rows;
      expect(jobs.map((j) => j.purpose)).toEqual(
        expect.arrayContaining(["booking_confirmed", "assignment_new"]),
      );
      const hist = (
        await c.query(
          "select to_status from appointment_status_history where appointment_id = $1 order by id",
          [booking.appointmentId],
        )
      ).rows;
      expect(hist.map((h) => h.to_status)).toEqual(["slot_held", "confirmed"]);
      const consents = (await c.query("select purpose, granted from customer_consents order by purpose"))
        .rows;
      expect(consents).toEqual([
        { purpose: "service_booking", granted: true },
        { purpose: "whatsapp_messaging", granted: true },
      ]);
    } finally {
      await c.end();
    }
  });

  it("an expired hold cannot be confirmed and releases the slot to others", async () => {
    const hold = await createHold(w.orgId, holdIn("hold-key-002"), clock);
    const later = clockAt(new Date(NOW.getTime() + 11 * 60_000));
    await expectCode(
      confirmHold(w.orgId, confirmIn(hold.holdToken, "confirm-key-002"), later),
      "HOLD_EXPIRED",
    );
    // another customer can now take the slot (lazy expiry inside the booking transaction)
    const second = await createHold(w.orgId, holdIn("hold-key-003"), later);
    expect(second.staffId).toBe(hold.staffId);
    expect(await count("select count(*) n from appointments where status = 'expired'")).toBe(1);
  });

  it("while a hold is live nobody else can take the slot", async () => {
    await createHold(w.orgId, holdIn("hold-key-004"), clock);
    await expectCode(createHold(w.orgId, holdIn("hold-key-005"), clock), "SLOT_TAKEN");
  });

  it("duplicate form submission (same idempotency key) returns the same hold and creates one appointment", async () => {
    const [a, b] = await Promise.all([
      createHold(w.orgId, holdIn("hold-key-006"), clock),
      createHold(w.orgId, holdIn("hold-key-006"), clock),
    ]);
    expect(a.holdId).toBe(b.holdId);
    expect(a.holdToken).toBe(b.holdToken);
    expect(await count("select count(*) n from appointments")).toBe(1);
    const c1 = confirmIn(a.holdToken, "confirm-key-006");
    const [x, y] = await Promise.all([confirmHold(w.orgId, c1, clock), confirmHold(w.orgId, c1, clock)]);
    expect(x.appointmentId).toBe(y.appointmentId);
    expect(await count("select count(*) n from customers")).toBe(1);
    expect(await count("select count(*) n from notification_jobs where purpose = 'booking_confirmed'")).toBe(
      1,
    );
  });

  it("reusing an idempotency key with a different request is rejected", async () => {
    await createHold(w.orgId, holdIn("hold-key-007"), clock);
    await expectCode(
      createHold(w.orgId, holdIn("hold-key-007", { startAt: at(DAY, "16:00") }), clock),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("forged or foreign hold tokens are rejected", async () => {
    const hold = await createHold(w.orgId, holdIn("hold-key-008"), clock);
    await expectCode(
      confirmHold(
        w.orgId,
        confirmIn(hold.holdId + ".AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "ck-008xxxx"),
        clock,
      ),
      "NOT_FOUND",
    );
  });

  it("customers can only book online-bookable services and within notice/advance limits", async () => {
    await expectCode(
      createHold(w.orgId, holdIn("hold-key-009", { startAt: new Date(NOW.getTime() + 30 * 60_000) }), clock),
      "MIN_NOTICE",
    );
    await expectCode(
      createHold(w.orgId, holdIn("hold-key-010", { startAt: at("2030-09-02", "11:00") }), clock),
      "MAX_ADVANCE",
    );
    const c = await adminClient();
    await c.query("update services set online_bookable = false where id = $1", [w.services.massage60]);
    await c.end();
    await expectCode(createHold(w.orgId, holdIn("hold-key-011"), clock), "NOT_FOUND");
  });

  it("releasing a hold frees the slot immediately", async () => {
    const hold = await createHold(w.orgId, holdIn("hold-key-012"), clock);
    await releaseHold(w.orgId, hold.holdToken);
    await createHold(w.orgId, holdIn("hold-key-013"), clock);
  });
});

describe("status machine, cancellation and rescheduling", () => {
  it("valid transitions succeed and invalid ones are rejected server-side", async () => {
    const mgr = managerPrincipal(w);
    const past = clockAt(at("2030-03-12", "00:00"));
    const b = await createDirectBooking(mgr, direct({ start: "11:00" }), clock);
    await expectCode(
      transitionAppointment(w.orgId, mgr, b.appointmentId, "completed", {}, clock),
      "NOT_ALLOWED",
    ); // not started yet
    await expectCode(
      transitionAppointment(w.orgId, mgr, b.appointmentId, "slot_held", {}, past),
      "INVALID_TRANSITION",
    );
    await transitionAppointment(w.orgId, mgr, b.appointmentId, "checked_in", {}, past);
    await transitionAppointment(w.orgId, mgr, b.appointmentId, "in_progress", {}, past);
    const done = await transitionAppointment(
      w.orgId,
      mgr,
      b.appointmentId,
      "completed",
      { actualMinutes: 65 },
      past,
    );
    expect(done.status).toBe("completed");
    await expectCode(
      transitionAppointment(w.orgId, mgr, b.appointmentId, "confirmed", {}, past),
      "INVALID_TRANSITION",
    ); // terminal
    await expectCode(
      cancelAppointment(w.orgId, { kind: "staff", principal: mgr }, b.appointmentId, {}, past),
      "INVALID_TRANSITION",
    );
  });

  it("the database refuses invalid transitions even if application code is bypassed", async () => {
    const mgr = managerPrincipal(w);
    const b = await createDirectBooking(mgr, direct({ start: "11:00" }), clock);
    const c = await adminClient();
    try {
      await c.query(
        "update appointments set status = 'cancelled_by_business', cancelled_at = now() where id = $1",
        [b.appointmentId],
      );
      await expect(
        c.query("update appointments set status = 'confirmed' where id = $1", [b.appointmentId]),
      ).rejects.toMatchObject({ code: "BK005" });
      await expect(
        c.query("update appointments set start_at = start_at + interval '1 hour' where id = $1", [
          b.appointmentId,
        ]),
      ).rejects.toMatchObject({ code: "BK006" });
    } finally {
      await c.end();
    }
  });

  it("a masseuse can progress her own appointment but not someone else's, and cannot cancel", async () => {
    const mgr = managerPrincipal(w);
    const past = clockAt(at("2030-03-12", "00:00"));
    const mine = await createDirectBooking(mgr, direct({ staffIdx: 0, start: "11:00" }), clock);
    const theirs = await createDirectBooking(mgr, direct({ staffIdx: 1, start: "11:00" }), clock);
    const aisyah = staffPrincipal(w, 0);
    await transitionAppointment(w.orgId, aisyah, mine.appointmentId, "completed", {}, past);
    await expectCode(
      transitionAppointment(w.orgId, aisyah, theirs.appointmentId, "completed", {}, past),
      "NOT_FOUND",
    );
    await expectCode(
      cancelAppointment(w.orgId, { kind: "staff", principal: aisyah }, theirs.appointmentId, {}, clock),
      "FORBIDDEN",
    );
  });

  it("customer cancels within policy; refused inside the cancellation window", async () => {
    const mgr = managerPrincipal(w);
    const b = await createDirectBooking(mgr, direct({ start: "11:00" }), clock);
    const c = await adminClient();
    const cust = (await c.query("select customer_id from appointments where id = $1", [b.appointmentId]))
      .rows[0].customer_id as string;
    await c.end();
    const near = clockAt(at(DAY, "00:00")); // 11h before start; policy is 24h
    await expectCode(
      cancelAppointment(
        w.orgId,
        { kind: "customer", customerId: cust, via: "manage_token" },
        b.appointmentId,
        {},
        near,
      ),
      "CANCELLATION_WINDOW",
    );
    const res = await cancelAppointment(
      w.orgId,
      { kind: "customer", customerId: cust, via: "manage_token" },
      b.appointmentId,
      {},
      clock,
    );
    expect(res.status).toBe("cancelled_by_customer");
  });

  it("rescheduling keeps history: old row 'rescheduled', new row linked, no conflict with itself", async () => {
    const mgr = managerPrincipal(w);
    const b = await createDirectBooking(mgr, direct({ start: "11:00" }), clock);
    const moved = await rescheduleAppointment(
      w.orgId,
      { kind: "staff", principal: mgr },
      { appointmentId: b.appointmentId, newStartAt: at(DAY, "11:30") },
      clock,
    );
    expect(moved.appointmentId).not.toBe(b.appointmentId);
    expect(moved.startAt).toBe(at(DAY, "11:30").toISOString());
    const c = await adminClient();
    try {
      const old = (
        await c.query("select status, rescheduled_to_id from appointments where id = $1", [b.appointmentId])
      ).rows[0];
      expect(old.status).toBe("rescheduled");
      expect(old.rescheduled_to_id).toBe(moved.appointmentId);
      expect(
        Number(
          (await c.query("select count(*) n from appointment_assignments where status = 'active'")).rows[0].n,
        ),
      ).toBe(1);
    } finally {
      await c.end();
    }
  });

  it("a failed reschedule leaves the original booking intact (atomic)", async () => {
    const mgr = managerPrincipal(w);
    const a = await createDirectBooking(mgr, direct({ start: "11:00" }), clock);
    await createDirectBooking(mgr, direct({ start: "14:00" }), clock);
    await expectCode(
      rescheduleAppointment(
        w.orgId,
        { kind: "staff", principal: mgr },
        { appointmentId: a.appointmentId, newStartAt: at(DAY, "14:00") },
        clock,
      ),
      "SLOT_TAKEN",
    );
    const c = await adminClient();
    const st = (await c.query("select status from appointments where id = $1", [a.appointmentId])).rows[0]
      .status;
    await c.end();
    expect(st).toBe("confirmed");
  });

  it("every important change writes an audit row with the actor", async () => {
    const mgr = managerPrincipal(w);
    const b = await createDirectBooking(mgr, direct({ start: "11:00" }), clock);
    await cancelAppointment(
      w.orgId,
      { kind: "staff", principal: mgr },
      b.appointmentId,
      { reason: "customer called" },
      clock,
    );
    const c = await adminClient();
    try {
      const rows = (
        await c.query(
          "select action, actor_user_id, actor_kind, after_data from audit_logs where entity_id = $1 order by id",
          [b.appointmentId],
        )
      ).rows;
      expect(rows.map((r) => r.action)).toEqual(["appointments.insert", "appointments.update"]);
      expect(rows[1].actor_user_id).toBe(mgr.userId);
      expect(rows[1].actor_kind).toBe("user");
      expect(rows[1].after_data.status).toBe("cancelled_by_business");
      const hist = (
        await c.query(
          "select to_status, reason, changed_by from appointment_status_history where appointment_id = $1 order by id",
          [b.appointmentId],
        )
      ).rows;
      expect(hist.at(-1)).toMatchObject({
        to_status: "cancelled_by_business",
        reason: "customer called",
        changed_by: mgr.userId,
      });
      // audit log is append-only
      await expect(c.query("delete from audit_logs")).rejects.toMatchObject({ code: "BK009" });
      await expect(c.query("update audit_logs set action = 'x'")).rejects.toMatchObject({ code: "BK009" });
    } finally {
      await c.end();
    }
  });
});
